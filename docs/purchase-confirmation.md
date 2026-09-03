# Confirmacion de compras (HU-60)

Para probar sin Docker puede definirse `MONGO_TEST_URI` apuntando a un Mongo replica set de pruebas. Cada suite crea una base `test_*_<UUID>` aislada y la elimina al finalizar; no usa la base de la aplicacion. Sin esa variable CI usa Testcontainers.

El outbox durable de Commerce llama `POST /api/internal/v1/notifications/purchases` en el puerto interno `PURCHASE_HTTP_PORT` (3003 por defecto). Esta entrada recibe una compra ya completada; no procesa pagos ni inventario y no depende de la cola en memoria del flujo general.

```json
{
  "notificationId": "22222222-2222-4222-8222-222222222222",
  "orderId": "33333333-3333-4333-8333-333333333333",
  "recipient": "jugador@example.com",
  "items": [
    {
      "productId": "11111111-1111-4111-8111-111111111111",
      "name": "Espada",
      "quantity": 2,
      "unitPrice": 1250
    }
  ],
  "currency": "COP",
  "total": 2500
}
```

Todos los importes son enteros en unidades menores (2500 = 25.00). Monedas COP, USD o EUR. UUID v1-5, entre 1 y 200 productos distintos, cantidades 1..9999. El total debe igualar la suma de cantidad por precio. Commerce obtiene el correo registrado de Account con identidad autenticada y lo persiste en su outbox junto al detalle; esta entrada no acepta tokens de usuario ni resuelve destinatarios del navegador.

## Configuracion y autenticacion

```dotenv
PURCHASE_HTTP_ENABLED=true
PURCHASE_HTTP_PORT=3003
PURCHASE_INBOX_DRIVER=mongo
MONGO_URL=mongodb://mongo:27017
MONGO_DB_NAME=notifications
INTERNAL_SERVICE_AUTH_SECRET=<secreto compartido>
EMAIL_DRIVER=smtp
```

No publicar el puerto3003 al exterior. Los puertos existentes HEALTH_PORT3001 e INGEST_PORT3002 conservan sus funciones. La entrada esta apagada por defecto y no cambia el transporte existente de Account/SQS. Production exige inbox Mongo y correo SMTP/SES; memory/fake solo sirven como dobles explicitos de desarrollo/pruebas.

Cabeceras: `x-internal-service: commerce`, `x-internal-timestamp` (milisegundos Unix), `x-internal-signature` (HMAC-SHA256 hexadecimal). Cadena: servicio, metodo POST, ruta exacta, timestamp, SHA256 del JSON canonico, separados por salto de linea. El JSON canonico ordena claves recursivamente y conserva arrays. El contrato coincide con Catalog/Inventory; ventana30segundos. Reintentar con firma actual y mismos notificationId/orderId/cuerpo.

## Entrega y reintentos

La coleccion Mongo `purchase_inbox` mantiene un identificador unico por notificacion y un indice unico por orderId. Guarda huella del comando, estado, token de lease y fechas; no necesita guardar el correo ni el cuerpo. El registro SENT no caduca. Una operacion CAS concede un lease de90segundos, renovado cada15segundos mientras se envia.

- 200 `{notificationId,status:"SENT"}`: el proveedor acepto el envio y el inbox guardo SENT; los replays devuelven el mismo resultado.
- 400: comando invalido. 401: HMAC invalido. 409: identificador o pedido reutilizado con otro comando.
- 503: operacion ocupada, proveedor no disponible o persistencia incierta. Commerce reintenta el mismo comando; nunca lo da por enviado solo por aceptar una solicitud.

La plantilla `commerce-purchase-confirmed-v1` incluye pedido, productos, cantidades, precio unitario, subtotal, moneda y total. Escapa contenido HTML y conserva alternativa texto. Indica el caracter simulado de la compra.

**Garantia real:** deduplicacion durable de entregas confirmadas y exclusion concurrente mediante lease, con entrega al menos una vez. SMTP/SES no ofrece una clave de idempotencia transaccional con Mongo. Si el proceso cae despues de que el proveedor acepta el mensaje y antes de guardar SENT, el siguiente intento puede enviar un duplicado. Un lease perdido durante un envio largo tiene la misma limitacion. SENT significa aceptado por el proveedor; no garantiza recepcion en la bandeja del usuario. No se promete exactly-once.

## Verificacion

`npm run test:coverage -- --runInBand` prueba contrato, HMAC, plantilla, totales, concurrencia y reintentos del proveedor. `npm run test:db -- --runInBand` usa MongoDB real via Testcontainers para verificar indices, replay tras recrear el adaptador y recuperacion CAS de un lease vencido. CI ejecuta ambas suites; Docker es requisito de la segunda.
