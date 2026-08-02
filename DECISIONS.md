# Decisiones técnicas — Kipu Wallet Ledger

## 1. Resumen ejecutivo

La prioridad es la correctitud contable bajo concurrencia. La solución usa PostgreSQL como frontera de consistencia, `READ COMMITTED`, locks pesimistas de fila, adquisición canónica de locks y transacciones explícitas. El ledger es append-only y la tabla de cuentas materializa el saldo para lecturas rápidas; constraint triggers diferidos impiden confirmar una transacción si el saldo y el ledger divergen.

No se confía solamente en que la aplicación haga lo correcto. Las invariantes esenciales también están expresadas en el esquema y se prueban directamente contra PostgreSQL.

## 2. Ambigüedades resueltas

### 2.1 Ledger fuente de verdad y saldo materializado

El enunciado permite no materializar el saldo, pero el script solicitado exige compararlo con el ledger. Decidí materializar `accounts.balance_minor` para lecturas O(1) y mantener el ledger como fuente de verdad auditable.

Ambos se modifican en la misma transacción. Triggers `DEFERRABLE INITIALLY DEFERRED` recalculan al `COMMIT` el saldo de cada cuenta afectada y rechazan cualquier divergencia. Son diferidos porque insertar asientos y actualizar saldos son pasos temporalmente inconsistentes dentro de una operación válida.

### 2.2 Origen del saldo inicial

Un crédito inicial aislado violaría partida doble. Se creó la cuenta interna `opening_balances`: la cuenta del cliente recibe `+amount` y la cuenta interna `-amount`. Esta última puede ser negativa porque representa fondeo/equity, no una billetera gastable.

### 2.3 Destino de una captura

El enunciado indica que el dinero sale definitivamente, pero no identifica beneficiario. La captura acredita `captured_funds`, una cuenta interna que representa fondos cobrados por el sistema o comercio. En un producto real, el hold incluiría merchant/beneficiary y la captura acreditaría su cuenta o una cuenta por pagar.

### 2.4 Regla de no negatividad

“Una cuenta jamás puede quedar negativa” se interpreta para cuentas de cliente. Las cuentas contables internas pueden ser negativas por diseño. El esquema distingue `kind = customer|system`, aplica la restricción únicamente a clientes y no expone cuentas internas en la API.

### 2.5 Moneda única

Se fijó `USD`; la moneda se conserva en cuentas y transacciones para hacer explícita la dimensión contable. Multimoneda requeriría cuentas internas por moneda, rechazo de cruces, conversión, FX y reglas de redondeo. No se presenta `KIPU_CURRENCY` como un switch funcional de multimoneda.

### 2.6 Representación del dinero

La API exige strings decimales con máximo dos cifras fraccionarias. `"1"`, `"1.2"` y `"1.20"` son equivalentes; `1.001`, `1e3`, números JSON, negativos y strings con espacios se rechazan. La aplicación convierte a `bigint` y PostgreSQL almacena `BIGINT` en centavos. IEEE-754 nunca participa en cálculos monetarios.

### 2.7 Transferencia a la misma cuenta

Se rechaza con `422 SAME_ACCOUNT_TRANSFER`. Tratarla como no-op exitoso ocultaría errores del cliente, produciría un ledger sin efecto económico y complicaría la semántica idempotente.

### 2.8 Semántica de holds

- La captura es total; no se solicitó captura parcial.
- Crear o liberar un hold no genera ledger porque la propiedad del dinero no cambia.
- La captura sí genera ledger y reduce el saldo contable.
- `expiresAt` debe estar en el futuro según `clock_timestamp()` de PostgreSQL.
- Un hold vencido deja de computar inmediatamente aunque su fila todavía diga `active`; al tocarlo se materializa `expired`.
- Captura y liberación son idempotentes para el mismo estado final. Si compiten, el lock permite un único ganador.

### 2.9 Idempotencia

Las transferencias exigen `Idempotency-Key` de 1 a 128 caracteres ASCII visibles. La identidad de la operación es un SHA-256 de una representación canónica versionada con UUID normalizados y monto convertido a centavos.

La reserva, el movimiento, el ledger, los saldos y la respuesta viven en una sola transacción:

1. `INSERT ... ON CONFLICT DO NOTHING` intenta reservar `(scope, key)`.
2. Una solicitud concurrente con la misma llave espera la resolución de la primera en el índice único.
3. Si el hash difiere, responde `409 IDEMPOTENCY_KEY_REUSED`.
4. Si coincide, devuelve el status y cuerpo persistidos.
5. Si la operación original revierte, también revierte la reserva; no queda una llave huérfana.

Se almacenan respuestas exitosas, que pueden dejar un efecto monetario ambiguo tras un timeout. Los errores de validación o fondos insuficientes revierten la reserva. En producción definiría por endpoint qué errores deterministas se cachean y agregaría TTL o archivado de llaves.

### 2.10 Paginación estable

No se usa offset. El orden total es `(created_at DESC, id DESC)` y el cursor opaco y versionado contiene ambos valores. La página siguiente usa una comparación estricta `<`. Un movimiento insertado después de entregar la primera página queda antes de la frontera y no produce duplicados ni saltos en páginas antiguas.

### 2.11 Códigos HTTP

- `400`: representación inválida, como JSON, schema, UUID, header o cursor.
- `404`: recurso inexistente.
- `409`: conflicto con el estado actual, como fondos, idempotencia o transición de hold.
- `422`: intención bien formada pero inválida, como monto, misma cuenta o expiración.

## 3. Modelo contable

Desde la perspectiva de una cuenta, un crédito es positivo y un débito negativo. Toda `ledger_transaction` debe tener al menos dos `ledger_entries` y suma algebraica cero.

| Operación | Débito | Crédito |
|---|---|---|
| Saldo inicial | `opening_balances` | Cuenta cliente |
| Transferencia | Cuenta origen | Cuenta destino |
| Captura de hold | Cuenta cliente | `captured_funds` |

### Invariantes de base de datos

1. Triggers rechazan `UPDATE` y `DELETE` en cabeceras y asientos del ledger.
2. Un trigger diferido exige al menos dos asientos y suma cero.
3. Las cuentas de cada asiento deben coincidir con la moneda de la transacción.
4. `CHECK (kind = 'system' OR balance_minor >= 0)` impide sobregiros de clientes.
5. Un trigger diferido compara `accounts.balance_minor` con `SUM(ledger_entries.amount_minor)`.
6. Un asiento por cuenta y transacción evita duplicados accidentales en el modelo actual.
7. `capture_transaction_id` existe únicamente si el hold está `captured`.

Los triggers diferidos agregan trabajo al commit. Es un trade-off deliberado para este núcleo financiero. A gran escala mediría el costo y evaluaría funciones SQL únicas por operación, reconciliación continua y snapshots sin debilitar las invariantes.

## 4. Estrategia de concurrencia

### Elección

Se usa `READ COMMITTED` con bloqueo pesimista `SELECT ... FOR UPDATE`.

- Una transferencia bloquea origen y destino en orden ascendente de UUID con una consulta.
- Crear un hold bloquea la cuenta antes de calcular disponibilidad.
- Capturar o liberar descubre la cuenta, bloquea las cuentas involucradas en orden y después bloquea el hold.
- La disponibilidad se calcula después de obtener el lock. Todo escritor que consume o reserva fondos toma el mismo lock de cuenta.

Las decisiones sobre fondos disponibles quedan serializadas por cuenta. Dos solicitudes no pueden aprobarse basadas en el mismo saldo anterior.

### Orden canónico y deadlocks

Las transferencias cruzadas A→B y B→A son el caso clásico: bloquear primero el origen formaría un ciclo. Ambas consultas ordenan los UUID y adquieren las filas en el mismo orden, eliminando ese ciclo conocido.

Como defensa adicional, el wrapper transaccional reintenta hasta tres veces `40P01` y `40001` con backoff exponencial corto y jitter. El orden canónico evita los deadlocks previstos; los reintentos cubren ciclos futuros entre recursos nuevos o fallos de serialización si cambia el aislamiento.

### Por qué no otras alternativas

- `SERIALIZABLE`: introduce abortos esperables y más reintentos bajo contención. Los locks explícitos expresan directamente la invariante por cuenta.
- Optimistic locking: las cuentas calientes generarían muchos conflictos y coordinar dos cuentas más holds sería más complejo.
- Advisory locks: no están ligados a filas ni integridad referencial y exigen que todos los escritores deriven exactamente la misma llave.
- Sólo `UPDATE ... WHERE balance >= amount`: protege un débito aislado, pero no coordina claramente dos cuentas, holds, ledger e idempotencia.

### Trade-off de `READ COMMITTED`

La operación que obtiene primero el lock define el orden observable. Una transferencia puede rechazarse si precede a una liberación concurrente; el cliente podrá reintentar después. Se prioriza nunca gastar de más sobre una disponibilidad optimista.

## 5. Fronteras transaccionales

### Crear cuenta con saldo inicial

Inserta la cuenta en cero, bloquea `opening_balances`, crea cabecera y dos asientos, y actualiza ambos saldos. Todo confirma o todo revierte.

### Transferir

Reserva idempotencia, bloquea cuentas canónicamente, calcula holds activos, valida fondos, agrega ledger, actualiza saldos y persiste la respuesta. Todo ocurre en una transacción.

### Crear hold

Bloquea la cuenta, suma holds activos no vencidos, valida disponibilidad y crea el hold sólo si la expiración sigue en el futuro al ejecutar el `INSERT`.

### Capturar hold

Bloquea cuenta cliente y cuenta interna, luego el hold. Revalida estado y expiración, agrega ledger, mueve saldos y marca `captured`. Una captura repetida devuelve la misma transacción.

### Liberar hold

Bloquea cuenta y hold. Cambia `active` a `released`, o a `expired` si ya venció. No modifica ledger ni saldo contable.

## 6. Expiración diseñada para AWS

Localmente la corrección no depende de un scheduler: las consultas excluyen `expires_at <= clock_timestamp()` y una captura vencida falla. Para materializar estados oportunamente en AWS usaría EventBridge Scheduler:

1. Al crear el hold, registrar un schedule one-shot nombrado a partir del `holdId` y con `FlexibleTimeWindow=OFF`.
2. Invocar una Lambda `expireHold` con ese ID.
3. Ejecutar un `UPDATE` condicional sobre holds activos ya vencidos; la operación sería idempotente.
4. Al capturar o liberar, intentar borrar el schedule como optimización.
5. Añadir DLQ, métricas de retraso y un barrido periódico de reconciliación.

EventBridge entrega al menos una vez y puede retrasarse; por eso PostgreSQL conserva la autoridad temporal. Step Functions sería razonable para un workflow de autorización con múltiples pasos, no para un único vencimiento.

## 7. Observabilidad

El adaptador HTTP emite logs JSON con timestamp, nivel, ruta, status, duración y `correlationId`; el mismo ID se devuelve en el header y en errores. No se registran payloads monetarios ni secretos. En producción agregaría métricas de dominio, tracing OpenTelemetry, métricas de retries SQL y alertas de reconciliación.

## 8. Qué quedó fuera

- Autenticación, autorización y ownership mediante JWT/OIDC y scopes.
- Depósitos y retiros posteriores a la apertura, con endpoints idempotentes y cuentas clearing.
- Multimoneda y FX, con quotes, redondeo y realized gain/loss.
- Captura parcial o incremental de holds.
- OpenAPI y consumer contract tests; se incluye `requests/kipu.http` para prueba manual.
- Infraestructura AWS completa: RDS, RDS Proxy, VPC, Secrets Manager, IAM y CI/CD.
- TTL y archivado de idempotency keys.
- Particionado del ledger, réplicas, snapshots y reconciliación incremental.
- Rate limiting, antifraude, límites operativos y auditoría de actor.

## 9. Ejercicio de code review

Problemas del fragmento heredado, ordenados de mayor a menor impacto:

1. **TOCTOU y sobregiro concurrente.** Lee el saldo antes de `BEGIN` y sin lock; dos requests pueden aprobar el mismo dinero y dejar la cuenta negativa.
2. **No existe ledger.** Sólo modifica una proyección mutable; no hay partida doble, auditoría, fuente de verdad ni reconciliación confiable.
3. **Un destino inexistente destruye dinero.** El débito puede afectar una fila y el crédito cero; no se verifica `rowCount` y el commit confirma la pérdida.
4. **No hay rollback ni manejo de excepciones.** Si un update o commit falla, la conexión queda en transacción abortada y puede conservar locks.
5. **La conexión nunca se libera.** Falta `client.release()` en éxito, fondos insuficientes y excepciones; el pool termina agotado.
6. **No hay idempotencia.** Un retry por timeout vuelve a mover el dinero.
7. **Transferencias cruzadas pueden hacer deadlock.** A→B y B→A actualizan en orden opuesto; no hay orden canónico ni retry de `40P01`.
8. **El monto no se valida.** Cero, negativos, strings extraños, `NaN`, infinitos o precisión excesiva alteran la operación; un negativo invierte el flujo.
9. **Origen inexistente produce una excepción.** `res.rows[0].balance` desreferencia `undefined` y además fuga la conexión.
10. **Comparación monetaria no tipada.** PostgreSQL suele devolver `BIGINT/NUMERIC` como string y `amount` viene de JSON; la coerción puede perder precisión.
11. **Ignora holds.** Compara saldo contable en vez de saldo disponible y puede gastar dinero reservado.
12. **La validación está fuera de la transacción.** Incluso añadir `FOR UPDATE` no serviría antes de `BEGIN`, porque el lock se liberaría al acabar la sentencia autocommit.
13. **No valida origen y destino distintos.** Una transferencia a sí misma ejecuta dos updates y reporta éxito sin movimiento económico útil.
14. **No valida moneda.** Podría mover valores nominales entre cuentas incompatibles al ampliar el modelo.
15. **No comprueba filas afectadas.** Débito y crédito pueden afectar cero filas sin que el handler lo detecte.
16. **`event: any` elimina garantías.** No existe un contrato tipado de API Gateway y los errores de estructura pasan a runtime.
17. **Parsing inseguro.** No maneja body ausente, base64, JSON inválido o payload con shape incorrecto.
18. **Errores inconsistentes.** No hay códigos estables, content type, detalles de validación ni correlation ID.
19. **No hay constraints defensivos.** La base permite saldos negativos, mutación arbitraria y divergencia entre saldo y movimientos.
20. **No hay timeouts, logs ni métricas.** No existe trazabilidad para investigar pérdida de dinero, contención o reintentos.

La parametrización sí evita inyección SQL en esas sentencias. El problema central no es interpolación: es atomicidad, concurrencia, validación, invariantes y lifecycle de la conexión.
