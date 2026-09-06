# Arquitectura de Nexus-Battle-Notifications

Documento técnico del servicio. La arquitectura del sistema completo, los ADR y los diagramas viven en [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure).

## Bounded context

**Notifications** es responsable de entregar notificaciones transaccionales a los usuarios. Su lenguaje ubicuo se limita a notificación, plantilla, destinatario, intento, entrega y descarte.

No es responsable de decidir _cuándo_ debe notificarse algo. Esa decisión pertenece a los contextos emisores (Account, Commerce, Community). Notifications recibe la solicitud, no la origina.

### Datos que posee

Notifications no posee datos de negocio persistentes en el alcance de Sprint 1. Mantiene un registro de idempotencia de vida corta para no reenviar la misma notificación.

No lee ni escribe en la base de datos de ningún otro servicio, y no mantiene claves foráneas hacia ellas.

## Capas

```text
+-------------------------------------------------------------+
|  adapters/inbound        NotificationConsumer                |
+-------------------------------------------------------------+
|  application             SendTransactionalEmail              |
|                          ports/ (contratos de salida)        |
+-------------------------------------------------------------+
|  domain                  Notification, RetryPolicy,          |
|                          EmailAddress, TemplateId, eventos   |
+-------------------------------------------------------------+
|  adapters/outbound       FakeEmailSender, SmtpEmailSender,   |
|                          InMemoryTemplateRenderer,           |
|                          InMemoryMessageQueue,               |
|                          InMemoryIdempotencyStore            |
+-------------------------------------------------------------+
|  infrastructure          config, observability, http, aws,   |
|                          bootstrap (raiz de composicion)     |
+-------------------------------------------------------------+
```

Las dependencias apuntan siempre hacia el dominio. El dominio no conoce ninguna capa exterior.

## Puertos

| Puerto                 | Responsabilidad                                       | Implementaciones actuales            |
| ---------------------- | ----------------------------------------------------- | ------------------------------------ |
| `EmailSenderPort`      | Entregar un correo a un proveedor                     | `FakeEmailSender`, `SmtpEmailSender` |
| `TemplateRendererPort` | Resolver asunto, HTML y texto de una plantilla        | `InMemoryTemplateRenderer`           |
| `MessageQueuePort`     | Recibir, confirmar, reencolar y descartar mensajes    | `InMemoryMessageQueue`               |
| `IdempotencyStorePort` | Reservar, confirmar y liberar claves de deduplicación | `InMemoryIdempotencyStore`           |
| `EventPublisherPort`   | Publicar eventos de dominio                           | `LoggingEventPublisher`              |
| `ClockPort`            | Proveer el instante actual                            | `SystemClock`                        |

`ClockPort` existe para que el dominio y los casos de uso sean deterministas: ninguna regla lee el reloj del sistema por su cuenta, de modo que las pruebas no necesitan falsear temporizadores globales.

## Patrones aplicados

| Patrón                          | Dónde                                             | Por qué                                                                                |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Adapter / Ports                 | Todas las dependencias externas                   | Permite sustituir proveedor de correo o cola sin tocar el dominio                      |
| Idempotent Consumer             | `SendTransactionalEmail` + `IdempotencyStorePort` | Una cola con entrega "al menos una vez" puede reentregar; el correo no debe duplicarse |
| Retry con retroceso exponencial | `RetryPolicy`                                     | Un proveedor caído no debe recibir reintentos inmediatos en bucle                      |
| Dead Letter Queue               | `MessageQueuePort.deadLetter`                     | Un mensaje que nunca podrá procesarse debe salir del flujo en lugar de bloquearlo      |
| Domain Events                   | `NotificationSent`, `NotificationFailed`          | Registra hechos del dominio de forma trazable y desacoplada del transporte             |

No se aplica CQRS ni Event Sourcing: el contexto no tiene un modelo de lectura diferenciado ni requiere reconstruir estado histórico.

## Decisión de reintento

La clasificación de un fallo determina si se reintenta:

| Situación                         | ¿Reintentable? | Motivo                                                            |
| --------------------------------- | -------------- | ----------------------------------------------------------------- |
| Plantilla inexistente             | No             | Es un defecto de configuración; reintentar produce el mismo error |
| Mensaje malformado                | No             | El contenido nunca será válido                                    |
| Destinatario con formato inválido | No             | Regla de dominio incumplida                                       |
| Rechazo SMTP 5xx                  | No             | Rechazo permanente del servidor                                   |
| Rechazo SMTP 4xx                  | Sí             | Condición temporal                                                |
| Fallo de red sin código           | Sí             | Indisponibilidad probable                                         |

El número de intento proviene del contador de entregas de la cola (`receivedCount`, equivalente a `ApproximateReceiveCount` en SQS) y no del estado en memoria del proceso. Sin esa propagación, cada reentrega reconstruiría el agregado desde cero y la política de reintentos nunca se agotaría.

## Contrato asíncrono

Mensaje aceptado por el worker:

```json
{
  "notificationId": "n-8f3c",
  "recipient": "jugador@nexus.test",
  "templateId": "account-verification-code",
  "variables": { "displayName": "Ana", "code": "123456", "expiresInMinutes": 10 },
  "idempotencyKey": "opcional"
}
```

Los identificadores de plantilla forman parte del contrato. Añadir o retirar una plantilla es un cambio de contrato y debe reflejarse en el catálogo de eventos de Nexus-Battle-Infrastructure.

Eventos de dominio emitidos:

| Evento                              | Cuándo                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `notifications.notification.sent`   | La entrega fue aceptada por el proveedor              |
| `notifications.notification.failed` | La entrega falló; el evento indica si habrá reintento |

## Observabilidad

El registro es JSON estructurado por línea, con `timestamp`, `level`, `service`, `version` y `message`. Se emite exclusivamente desde `infrastructure/observability/logger.ts`; el resto del código tiene prohibido escribir en la consola mediante la regla `no-console` de ESLint.

No se registran cuerpos de correo ni contenido renderizado.

## Salud

`/health/live` confirma que el proceso responde y no consulta dependencias, porque reiniciar el worker no repara una dependencia caída. `/health/ready` evalúa el estado real del consumidor y del último sondeo de la cola, y responde `503` cuando alguna comprobación falla. Una comprobación que lanza una excepción cuenta como fallo, nunca como éxito.

## Limitaciones conocidas del alcance actual

- La cola y el almacén de idempotencia son en memoria: son correctos para **una sola instancia** del worker, que es la topología de la demo. Una topología multiinstancia requiere una cola compartida y un almacén de idempotencia compartido.
- El estado se pierde al reiniciar el proceso. En la demo esto es aceptable; no lo sería en un entorno con garantías de entrega.
- El adaptador SQS no está implementado. La configuración se valida y el nombre de la cola se resuelve, pero la adopción depende de que ADR-006 pase a `Accepted`.
- No se integra ningún proveedor de correo real. `FakeEmailSender` es el adaptador por defecto y `SmtpEmailSender` apunta a Mailpit en local.

Estas limitaciones están declaradas de forma explícita para que la arquitectura de demo no se confunda con la arquitectura objetivo, documentada en `docs/architecture/target-scale-deployment.md` de Nexus-Battle-Infrastructure.

## HU-38 — Notificaciones de catálogo al iniciar sesión y banner informativo

HU-38 añade un segundo bounded context de lectura/escritura dentro de este mismo
servicio, deliberadamente separado del correo transaccional:

```text
CatalogNotification   in-app, dirigida a un jugador o GLOBAL (todos)
BannerEntry           anuncio administrado manualmente por Admin/Super Admin
```

**No es el mismo agregado que `Notification`** (correo, HU-04/HU-33.10): sus
invariantes son distintas -intentos de entrega y política de reintentos de
proveedor, frente a estado de lectura y consolidación-. `HandleCatalogProductCreated`
(correo) sigue sin tocarse; `HandleCatalogProductCreatedNotifications` la
compone junto con la nueva reacción in-app sobre el mismo mensaje de
`catalog.product.created`, porque `MessageQueuePort` tiene semántica de
consumidor competitivo y dos consumidores separados sobre la misma cola se
robarían mensajes en vez de recibirlos los dos.

### Eventos consumidos

| `eventType` (Catalog)                | Notificación | Destinatarios                       |
| ------------------------------------ | ------------ | ----------------------------------- |
| `catalog.product.created`            | GLOBAL       | Todos (HU-38 no filtra este evento) |
| `catalog.product.inventory.adjusted` | GLOBAL       | Todos                               |
| `catalog.product.premium.configured` | GLOBAL       | Todos                               |
| `catalog.product.suspended`          | PLAYER       | Quienes poseen el producto          |
| `catalog.product.reactivated`        | PLAYER       | Quienes poseían el producto         |

`catalog.product.stock.depleted` **no se consume**: no aparece en el alcance
funcional de HU-38 (Management #46), es una consecuencia de compras, no una
acción administrativa de HU-033 a HU-037. No hay evento de "diseño" (HU-37) en
Catalog todavía, así que ese tipo de cambio tampoco tiene contraparte real.

### Destinatarios de suspensión/reactivación

Resuelto contra `Nexus-Battle-Player-Inventory#23`
(`GET /api/internal/v1/inventory/products/{productId}/owners`, contrato
servicio-a-servicio con HMAC-SHA256). `PlayerInventoryProductOwnersResolver`
implementa `ProductOwnersResolverPort`: firma la petición con
`internal-signature.ts` -la misma función que este servicio ya usaba para
VERIFICAR la firma de Commerce en `purchase-server.ts`, ahora usada también
como cliente- y traduce la respuesta a `{ available: true, playerIds }`.

Cualquier fallo -red, timeout, `4xx`/`5xx`, JSON ilegible, forma de respuesta
inesperada, un `productId` de respuesta que no coincide con el pedido, o el
resolver sin configurar (`UnavailableProductOwnersResolver`)- se traduce a
`{ available: false, reason }`, **nunca** a `playerIds: []`: confundir "no se
pudo preguntar" con "no tiene propietarios" perdería notificaciones en
silencio.

**Corrección importante (tras detectar la brecha):** antes de esta
corrección, `available: false` SIEMPRE confirmaba la idempotencia y
confirmaba el mensaje (`ACK`) como si hubiera terminado con éxito -una
decisión razonable mientras la brecha era "el contrato no existe", pero que
tras integrar una llamada HTTP real (Player-Inventory#23) perdía la
notificación para siempre ante cualquier fallo transitorio: timeout, un
reinicio de Player-Inventory, un `503` momentáneo-. Ahora:

```text
Catalog lifecycle event (suspended/reactivated)
        ↓
Notifications (HandleCatalogLifecycleEvent)
        ↓
Player-Inventory (ProductOwnersResolverPort)
        ↓
disponible          → crear CatalogNotification PLAYER, confirmar, ACK
no disponible       → liberar idempotencia, NO confirmar, reencolar (RetryPolicy)
intentos agotados   → confirmar, dead-letter (no se pierde: queda en la DLQ)
```

`HandleCatalogLifecycleEvent.execute()` ahora recibe `deliveryAttempt` (igual
que `HandleCatalogProductCreated`) y reutiliza la MISMA `RetryPolicy` -sin
variables ni números nuevos, `MAX_ATTEMPTS`/`RETRY_BASE_DELAY_MS`/
`RETRY_MAX_DELAY_MS` de siempre- para decidir entre `Retry` y `DeadLetter`.
`CatalogLifecycleEventsConsumer` sigue exactamente el mismo patrón de
`CatalogProductEventsConsumer`: `Retry` reencola (`queue.requeue`, nunca
`acknowledge`), `DeadLetter` va a la cola de fallidos
(`queue.deadLetter`), y solo `Processed`/`Duplicated` confirman el mensaje.
El resolver sin configurar sigue exactamente esta misma ruta -nunca un `ACK`
permanente disfrazado de éxito, y nunca cae a audiencia GLOBAL como
sustituto-.

En el caso de `DeadLetter` se confirma la idempotencia (mismo criterio que
`HandleCatalogProductCreated`): una redelivery del mismo `eventId` no
reprocesa el mismo fallo indefinidamente. Un replay manual desde la cola de
fallidos requiere limpiar esa reserva explícitamente, igual que ya exige hoy
el flujo de correo.

El adaptador HTTP es **opcional y falla cerrado por diseño**: sin
`PLAYER_INVENTORY_BASE_URL` o sin `INTERNAL_SERVICE_AUTH_SECRET` (el mismo
secreto compartido que ya exige `PURCHASE_HTTP_ENABLED`), la composición usa
`UnavailableProductOwnersResolver` -el mismo comportamiento seguro que existía
antes de esta integración, no un adaptador nuevo a medio configurar- y lo
registra al arrancar (`product_owners_resolver_not_configured`). Con ambas
variables presentes, se registra `product_owners_resolver_configured`. Sigue
siendo **at-least-once + idempotencia**, nunca exactly-once: una redelivery
tras un `Retry` puede, en teoría, llegar a resolver dos veces si el reencolado
compite con una redelivery natural de la cola: la clave de idempotencia sigue
siendo la única garantía contra notificaciones duplicadas, igual que en el
resto del servicio.

**Brecha que permanece:** esta integración resuelve el tramo
Notifications→Player-Inventory. El tramo Catalog→Notifications sigue
limitado por la brecha de transporte descrita abajo: sin una cola real para
`catalog.product.suspended`/`reactivated`, el evento no llega en producción
para que este resolver tenga ocasión de actuar. TASK #175 permanece abierta
hasta que exista evidencia E2E completa (evento → transporte real →
Notifications → Player-Inventory → notificación persistida).

### Estado del transporte de eventos de Catalog

ADR-017 (Infrastructure) está `Accepted` y su cola dedicada para
`catalog.product.created` ya está **provisionada como código Terraform**
(Infrastructure#93); todavía no se aplicó contra una cuenta real
(`terraform apply` pendiente). El transporte de `catalog.product.created` se
activa con `CATALOG_QUEUE_DRIVER=sqs` -independiente de `QUEUE_DRIVER`, ver
`.env.example`-, sin exigir la cola general de ADR-006.

Los cuatro eventos de ciclo de vida (`suspended`/`reactivated`/
`inventory.adjusted`/`premium.configured`) ya tienen decisión de transporte:
**ADR-018 (Infrastructure) está `Accepted`** ([Management #314](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/314)),
y su cola compartida -con DLQ propia, distinta de la de `created` y de la
general- ya está **provisionada como código Terraform**
(`infra/modules/catalog_lifecycle_events_queue`, Infrastructure#95); todavía
no se aplicó contra una cuenta real. `CatalogLifecycleEventsConsumer` ya
puede activarse por SQS de forma **independiente** de `QUEUE_DRIVER` y de
`CATALOG_QUEUE_DRIVER` mediante `CATALOG_LIFECYCLE_QUEUE_DRIVER=sqs` -mismo
criterio explícito, sin inferencia por presencia de URL, que
`CATALOG_QUEUE_DRIVER` ya aplicaba para `created`-, y ya no reenvía a la DLQ
general: un mensaje irreprocesable sigue la redrive policy de su propia cola
dedicada. Sin `CATALOG_LIFECYCLE_QUEUE_DRIVER=sqs` (el valor por defecto es
`memory`), el consumidor se ejercita en memoria local, lo cual se registra
explícitamente en el arranque (`catalog_lifecycle_queue_not_configured`).

Ninguno de los dos transportes está `Applied`/`Deployed`: `terraform apply`
sigue sin ejecutarse en Infrastructure, y Catalog sigue sin un dispatcher que
publique sus outbox hacia ninguna de las dos colas (confirmado ausente en
código, brecha de Catalog).

### Consolidación

`GetPlayerNotifications` agrupa por `(productId, changeType)`: dos o más
notificaciones pendientes del mismo producto y mismo tipo de cambio se
presentan como una entrada ("Armadura de Escamas tuvo 4 actualizaciones
recientes; ver detalle"), conservando las notificaciones originales para el
historial. No se agrupan tipos de cambio distintos del mismo producto -una
suspensión aislada no debe quedar enterrada dentro de un lote de ajustes de
tiraje-, ni productos distintos entre sí.

### Marcado como leído

Presentar y marcar como leída son dos operaciones separadas
(`GET .../pending` y `POST .../read`), no una sola: automatizar la escritura
dentro de la lectura habría hecho que un simple refresco de pantalla marcara
notificaciones como vistas sin que el jugador las haya visto de verdad.

### Superficie HTTP (opcional, `CATALOG_NOTIFICATIONS_HTTP_ENABLED`)

| Ruta                               | Método    | Quién                                 |
| ---------------------------------- | --------- | ------------------------------------- |
| `/api/v1/notifications/me/pending` | GET       | Jugador autenticado (su propio `sub`) |
| `/api/v1/notifications/me/history` | GET       | Jugador autenticado                   |
| `/api/v1/notifications/me/read`    | POST      | Jugador autenticado                   |
| `/api/v1/banners`                  | GET       | Público, sin testimonio               |
| `/api/v1/admin/banners`            | GET, POST | ADMINISTRATOR o SUPER_ADMINISTRATOR   |

El `playerId` siempre se deriva de `VerifiedIdentity.subject` (testimonio JWT
de Cognito, verificado con `aws-jwt-verify` igual que Account/Catalog); nunca
se acepta desde la URL o el cuerpo. MODERATOR no está autorizado sobre el
banner: HU-38 solo nombra Admin y Super Admin.

### HU-38.6 — Correo: NO APLICA

No se implementó ninguna integración con el módulo de correo para HU-38.
HU-38 y RF-38 exigen notificación in-app y banner como canal principal; no
existe una regla de negocio aprobada que obligue a replicar por correo la
creación, el ajuste de tiraje, la condición Premium, la suspensión o la
reactivación de un producto. `SesEmailSender`, `SmtpEmailSender` y las
plantillas existentes no se tocaron.
