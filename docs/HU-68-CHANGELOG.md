# Changelog / Registro de Cambios — HU-68

## TASK 68.4 — Notificaciones de subastas

- Se añadió un adaptador HTTP interno que valida firma HMAC, servicio y vigencia del sello temporal.
- Se parsean de forma estricta los eventos versionados de cambio y cierre próximo.
- Se crean notificaciones persistentes por jugador mediante el repositorio ya compartido por la API in-app.
- La identidad determinista `evento + jugador` vuelve idempotentes los reintentos y replays.
- Se añadieron pruebas unitarias y de integración HTTP para persistencia, duplicados y firmas inválidas.

### Decisión técnica

Se reutilizó el almacén y la API de notificaciones existentes. Auction entrega los eventos por el canal HTTP interno firmado que ya usa el ecosistema para integraciones síncronas entre servicios; el contrato permanece detrás de un puerto de publicación y puede sustituirse por un adaptador de cola sin cambiar los casos de uso.
