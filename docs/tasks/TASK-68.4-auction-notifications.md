# TASK 68.4 — Recepción y generación de notificaciones

Historia: HU-68 — Lista de seguimiento de subastas.  
Referencia: `Refs Nexus-Battle-VI/Nexus-Battle-Management#53`.

## Resultado funcional

Notifications recibe eventos internos de Auction y crea una notificación in-app persistente para cada destinatario único. Los avisos quedan disponibles mediante los endpoints existentes de pendientes e historial.

| Evento recibido                | Tipo almacenado        | Mensaje                         |
| ------------------------------ | ---------------------- | ------------------------------- |
| `auction.watchlist.changed.v1` | `AUCTION_CHANGED`      | Cambio de la puja líder.        |
| `auction.closing-soon.v1`      | `AUCTION_CLOSING_SOON` | La subasta termina en una hora. |

## Seguridad e idempotencia

El endpoint `POST /api/internal/v1/notifications/auction/watchlist-events` valida:

- Servicio emisor `auction`.
- Sello temporal con una ventana máxima de 30 segundos.
- Firma HMAC SHA-256 calculada sobre servicio, método, ruta, sello y cuerpo canónico.
- Forma estricta y versión soportada del evento.

La identidad de cada notificación se obtiene mediante SHA-256 de `eventId + playerId`. Un replay devuelve estado `duplicated` y no crea una segunda fila. Mongo conserva además la protección de su clave única.

## Arquitectura

- El parser de mensajería traduce JSON externo al DTO de aplicación.
- `HandleAuctionWatchlistEvent` depende solo de los puertos de reloj y repositorio.
- El servidor HTTP es el adaptador de entrada.
- El repositorio ya compartido por Notifications conserva los avisos y permite que Web los consulte sin una segunda fuente de datos.

El transporte actual sigue el canal HTTP interno firmado ya usado entre servicios. El productor depende de un puerto, de modo que puede añadirse un adaptador de cola sin modificar los casos de uso.

## TDD: Red → Green → Refactor

1. **Red:** se escribieron primero los casos de destinatarios únicos, replay y cierre próximo.
2. **Green:** se implementaron DTO, parser, caso de uso y nuevos tipos.
3. **Refactor:** se centralizó el identificador determinista y se conectó el manejador al servidor existente.

La integración HTTP verifica una entrega firmada real, replay sin duplicados y rechazo de firma inválida.

## Validación final

| Verificación                  |                 Resultado |
| ----------------------------- | ------------------------: |
| Suite completa                | 354 aprobadas, 0 fallidas |
| Sentencias                    |                   93,89 % |
| Ramas                         |                   87,72 % |
| Funciones                     |                   93,88 % |
| Líneas                        |                   94,12 % |
| TypeScript, ESLint y Prettier |                 Aprobados |

Todas las métricas superan RNF-16 (80 %).

## Changelog / Registro de cambios

### Archivos creados

- `src/application/dto/AuctionWatchlistEvent.ts`
- `src/application/use-cases/HandleAuctionWatchlistEvent.ts`
- `src/adapters/messaging/AuctionWatchlistEventParser.ts`
- `tests/unit/application/HandleAuctionWatchlistEvent.test.ts`

### Archivos modificados

- `CatalogChangeType.ts` para los dos tipos de Auction.
- Configuración y raíz de composición para el secreto interno y el manejador.
- Servidor HTTP y prueba de integración para el endpoint firmado.

Commit: `feat(notifications): handle auction watchlist events #TASK-68.4`.  
PR: https://github.com/Nexus-Battle-VI/Nexus-Battle-Notifications/pull/35
