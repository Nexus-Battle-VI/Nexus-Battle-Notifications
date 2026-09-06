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

| `eventType` (Catalog) | Notificación | Destinatarios |
| --- | --- | --- |
| `catalog.product.created` | GLOBAL | Todos (HU-38 no filtra este evento) |
| `catalog.product.inventory.adjusted` | GLOBAL | Todos |
| `catalog.product.premium.configured` | GLOBAL | Todos |
| `catalog.product.suspended` | PLAYER | Quienes poseen el producto |
| `catalog.product.reactivated` | PLAYER | Quienes poseían el producto |

`catalog.product.stock.depleted` **no se consume**: no aparece en el alcance
funcional de HU-38 (Management #46), es una consecuencia de compras, no una
acción administrativa de HU-033 a HU-037. No hay evento de "diseño" (HU-37) en
Catalog todavía, así que ese tipo de cambio tampoco tiene contraparte real.

### Brecha conocida: destinatarios de suspensión/reactivación

Player-Inventory no expone ningún contrato -API interna, evento o
proyección- para resolver "¿qué jugadores poseen el producto X?"; su
superficie actual solo resuelve la dirección contraria (dado un jugador, qué
posee). Notifications no tiene permitido acceder directamente a su base de
datos. `ProductOwnersResolverPort` documenta esta brecha; su única
implementación, `UnavailableProductOwnersResolver`, declara la resolución "no
disponible" en vez de inventar una lista. Un evento de suspensión/reactivación
que llega hoy se confirma con el resultado `RecipientsUnresolved` -no se
reintenta indefinidamente, porque no es un fallo transitorio- y queda
registrado para trazabilidad, sin crear ninguna notificación. Resolver esto
requiere un contrato nuevo entre Player-Inventory e Infrastructure.

### Brecha conocida: transporte de los cuatro eventos de ciclo de vida

Infrastructure solo provisiona (como propuesta, ADR-017, no desplegada) una
cola para `catalog.product.created`. Los otros cuatro eventos de esta tabla no
tienen canal ni cola definidos todavía. `CatalogLifecycleEventsConsumer` existe
y se ejercita en memoria (desarrollo y pruebas); en un despliegue real, sin
`CATALOG_LIFECYCLE_QUEUE_URL`, cae a una cola en memoria local sin transporte,
lo cual se registra explícitamente en el arranque (`catalog_lifecycle_queue_not_configured`).

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

| Ruta | Método | Quién |
| --- | --- | --- |
| `/api/v1/notifications/me/pending` | GET | Jugador autenticado (su propio `sub`) |
| `/api/v1/notifications/me/history` | GET | Jugador autenticado |
| `/api/v1/notifications/me/read` | POST | Jugador autenticado |
| `/api/v1/banners` | GET | Público, sin testimonio |
| `/api/v1/admin/banners` | GET, POST | ADMINISTRATOR o SUPER_ADMINISTRATOR |

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
