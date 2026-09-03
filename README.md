# Nexus-Battle-Notifications

Worker de notificaciones transaccionales de Nexus Battles VI. Implementa el bounded context **Notifications**: recibe solicitudes de notificación desde una cola de mensajes, resuelve la plantilla correspondiente y entrega el correo, aplicando idempotencia y una política de reintentos.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Team propietario:** Team Alfa
- **Arquitectura interna:** Clean + Hexagonal, con puertos y adaptadores
- **Documentación técnica del sistema:** [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure)

## Alcance

```text
Cola de mensajes
  -> NotificationConsumer      (adaptador de entrada)
  -> SendTransactionalEmail    (caso de uso)
  -> TemplateRendererPort      (plantillas)
  -> EmailSenderPort           (proveedor de correo)
  -> IdempotencyStorePort      (deduplicacion)
```

El worker no expone API de negocio. Su única superficie HTTP son las sondas de salud.

## Requisitos

| Herramienta | Versión                                       |
| ----------- | --------------------------------------------- |
| Node.js     | 24 LTS (`.nvmrc` fija el major 24)            |
| npm         | 11 o superior                                 |
| Docker      | opcional, para construir y ejecutar la imagen |

Este repositorio usa **npm** y `package-lock.json`. No se utilizan pnpm ni yarn.

## Puesta en marcha

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Con la configuración por defecto el worker arranca con la cola en memoria y el adaptador `FakeEmailSender`: no envía correo real y no requiere servicios externos.

## Scripts

| Script                     | Descripción                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run dev`              | Ejecuta el worker desde los fuentes TypeScript con recarga automática |
| `npm run build`            | Verifica tipos con TypeScript 7 y compila a `dist/`                   |
| `npm start`                | Ejecuta el worker compilado cargando `.env` si existe                 |
| `npm run start:prod`       | Ejecuta el worker compilado tomando la configuración del entorno      |
| `npm run typecheck`        | Verificación de tipos con TypeScript 7                                |
| `npm run lint`             | ESLint con reglas basadas en información de tipos                     |
| `npm run lint:fix`         | Corrige automáticamente lo que ESLint puede corregir                  |
| `npm run format`           | Aplica Prettier                                                       |
| `npm run format:check`     | Verifica el formato sin modificar archivos                            |
| `npm test`                 | Ejecuta todas las pruebas                                             |
| `npm run test:unit`        | Solo pruebas unitarias                                                |
| `npm run test:integration` | Solo pruebas de integración                                           |
| `npm run test:coverage`    | Pruebas con cobertura y umbral del 80 %                               |

## Sondas de salud

| Ruta                | Significado                                                    |
| ------------------- | -------------------------------------------------------------- |
| `GET /health/live`  | El proceso responde. No consulta dependencias                  |
| `GET /health/ready` | Evalúa las dependencias reales. Responde `503` si alguna falla |
| `GET /version`      | Servicio, versión y entorno                                    |

El puerto se configura con `HEALTH_PORT` (por defecto `3001`).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, eventos y politicas. Sin dependencias externas.
  application/       Casos de uso, puertos y DTO. Depende solo del dominio.
  adapters/          Implementaciones concretas de los puertos.
  infrastructure/    Configuracion, observabilidad, HTTP de salud y composicion.
  worker.ts          Punto de entrada del proceso.
tests/
  unit/              Pruebas unitarias por capa.
  integration/       Flujo completo y sondas HTTP reales.
```

El dominio no importa frameworks, SDK de AWS, ORM, HTTP ni drivers de base de datos. La restricción se verifica en CI mediante reglas de ESLint sobre `src/domain` y `src/application`.

## Compatibilidad de TypeScript

Este repositorio instala **dos** copias de TypeScript de forma deliberada:

| Paquete                               | Versión | Uso                                                     |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `typescript`                          | 6.0.3   | API JavaScript que consumen typescript-eslint y ts-jest |
| `typescript7` (alias de `typescript`) | 7.0.2   | Compilador y verificador de tipos del producto          |

`typescript-eslint` todavía no soporta TypeScript 7 y falla en ejecución si lo detecta. Este es el patrón _side-by-side_ documentado por el propio proyecto de TypeScript. La verificación de tipos autoritativa la realiza TypeScript 7. El detalle, la evidencia y la condición de salida están en `docs/adr/ADR-003-frontend-stack.md` de Nexus-Battle-Infrastructure.

## Docker

```bash
docker build -t nexus-battle-notifications:local .
docker run --rm -p 3001:3001 nexus-battle-notifications:local
```

La imagen es multi-etapa, se ejecuta con el usuario sin privilegios `node`, incluye solo dependencias de producción y no contiene secretos.

## Confirmacion de compras

La entrada interna desde el outbox de Commerce, inbox Mongo y limites de entrega SMTP estan en [docs/purchase-confirmation.md](docs/purchase-confirmation.md).

## Contribución

Se aplican las convenciones descritas en [CONTRIBUTING.md](CONTRIBUTING.md) y la [política de trazabilidad entre repositorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/blob/main/docs/governance/cross-repository-traceability.md) de Management.

## Licencia

`Licensing pending project governance`. Este repositorio todavía no tiene una licencia asignada; su definición requiere autorización del gobierno del proyecto.
