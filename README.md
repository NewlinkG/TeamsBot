# 🤖 OrbIT Bot para Microsoft Teams — Documentación Técnica Extendida

OrbIT es un asistente virtual empresarial desarrollado por **Newlink** para gestionar soporte técnico, automatización de tickets y consultas mediante inteligencia artificial dentro de Microsoft Teams. Este bot integra múltiples servicios: Helpdesk, OpenAI, Notion y Pinecone.

---

## 📂 Estructura del Repositorio

```
TeamsBot/
├── bot.js                  # Orquestador principal (handler de Teams)
├── openaiClient.js         # Cliente para Azure OpenAI (GPT)
├── retrievalClient.js      # Búsqueda semántica (embeddings)
├── ticketClient.js         # API de Helpdesk interna
├── ingest-notion/          # Indexación de artículos desde Notion
├── api-messages/           # API HTTP para entrada de mensajes
├── api-tabs/               # API para pestaña personalizada (Teams Tab)
├── api-tickets/            # API REST pública para tickets
├── tabs-portal/            # UI React (pestaña embebida en Teams)
├── teams-tab/              # Configuración para renderizado de pestaña
├── .env                    # Variables sensibles
├── package.json            # Dependencias
```

---

## 🚀 Funcionalidades Clave

### ✍️ Soporte Técnico Multicanal
- Crear, editar, cerrar y listar tickets desde Teams
- Confirmaciones de usuario vía Adaptive Cards
- Soporte multilingüe (es, pt, en)

### 🧠 Inteligencia Artificial
- Clasificación de intención (`classifySupportRequest()`)
- Prompting dinámico en flujos de soporte
- Streaming GPT-4o como fallback para respuestas abiertas

### 🔗 Integraciones
- **Helpdesk API**: soporte completo de tickets
- **Azure OpenAI**: generación contextual y fluida
- **Notion**: indexación periódica de artículos
- **Pinecone**: recuperación semántica

### 📎 Archivos y Comentarios
- Subida de adjuntos en edición de ticket
- Soporte para imágenes embebidas (HTML)
- Descarga autenticada vía token de MicrosoftAppCredentials

---

## 🧾 Endpoints HTTP (Triggers)

| Ruta                  | Descripción                             |
|-----------------------|------------------------------------------|
| `/api/messages`       | Entrada principal del bot (Teams)        |
| `/api/tickets`        | API REST para consultar/crear tickets    |
| `/api/tabs`           | Contenido dinámico para Teams Tab        |
| `/api/keepalive`      | Ping para mantener bot despierto         |

---

## 📌 Funciones Auxiliares Importantes

### `extractInlineImagesFromHtml(html, token, userEmail)`
- Extrae `<img src="...">` de contenido HTML
- Descarga las imágenes usando token de acceso
- Las convierte en `buffer` y las sube como adjuntos
- Retorna un arreglo de `attachmentTokenId[]`

```js
const imgRes = await axios.get(imageUrl, {
  responseType: 'arraybuffer',
  headers: { Authorization: `Bearer ${token}` }
});
```

### `renderTicketListCard(context, page, showClosed)`
- Renderiza lista paginada de tickets como AdaptiveCard
- Incluye acciones: ver, editar, cerrar

---

## 🔧 Variables de Entorno Relevantes

```env
MicrosoftAppId=
MicrosoftAppPassword=
HELPDESK_API_URL=
HELPDESK_API_KEY=
HELPDESK_WEB_URL=
OPENAI_KEY=
AZURE_OPENAI_ENDPOINT=
PINECONE_API_KEY=
NOTION_TOKEN=
...
```

---

## 🔁 Diagrama de Flujo Técnico

```mermaid
flowchart TD
  A[Usuario en Teams] --> B[API /api/messages]
  B --> C{¿Comando válido?}
  C -- Sí --> D[Procesar ticket (crear, cerrar, listar)]
  C -- No --> E[Llamar a GPT via openaiClient.js]
  E --> F{¿Respuesta válida?}
  F -- No --> G[Buscar artículos con retrievalClient (Pinecone)]
  G --> H[Responder con sugerencia de artículo]
  F -- Sí --> H
  D --> H

  subgraph Indexación Notion
    I[ingest-notion] --> J[Llama a Notion API]
    J --> K[Fragmenta y vectoriza]
    K --> L[Indexa en Pinecone]
  end
```

---

## 📦 Dependencias Clave

```json
"dependencies": {
  "express": "^4.18.2",
  "axios": "^1.6.7",
  "botbuilder": "^4.21.0",
  "dotenv": "^16.3.1",
  "openai": "^4.30.0",
  "notion-client": "^1.2.0"
}
```

---

## ✅ Mejores Prácticas Implementadas

- `conversationState` para control de flujos de conversación
- Confirmaciones visuales con Adaptive Cards
- Subida de adjuntos con autenticación segura
- Logs en consola para errores de carga de archivos

---

## 🧪 Pruebas y CI/CD

- Soporte para `jest` y `supertest` sugerido
- GitHub Actions recomendado para:
  - Test
  - Linter
  - Despliegue automático a Azure Web App

---

## 📬 Soporte

Para soporte técnico o contribuciones, escribe a [help@newlink-group.com](mailto:help@newlink-group.com)