# TeamsBot for Microsoft Teams — Comprehensive Technical Documentation (V2)
**Author:** Alfred Vilsmeier  
**Date:** 2025-05-25  

---

## 📂 Repository Structure
```text
TeamsBot-main/
├── .github/
│   └── workflows/
│       └── main_newlinker-fn.yml      # GitHub Actions CI/CD
├── api-keepalive/
│   ├── function.json                  # HTTP keepalive trigger
│   └── index.js                       # Handler for ping endpoint
├── api-messages/
│   ├── function.json                  # HTTP messages trigger (POST /api/messages)
│   └── index.js                       # Main bot message processor
├── api-tabs/
│   ├── function.json                  # HTTP tab content trigger (GET /api/tabs/{*file})
│   └── index.js                       # Serves React tab static assets
├── api-tickets/
│   ├── function.json                  # HTTP tickets API trigger (GET/POST /api/tickets/{id}/{action})
│   └── index.js                       # CRUD operations for Helpdesk tickets
├── api-zammad-wh/
│   ├── function.json                  # HTTP Zammad webhook trigger (POST /api/zammad-wh)
│   └── index.js                       # Receives ticket events, validates secret, and enqueues
├── ingest-notion/
│   ├── function.json                  # Timer trigger for Notion ingestion (hourly)
│   └── index.js                       # Indexes Notion content into Pinecone
├── warmup-ping/
│   ├── function.json                  # Timer trigger to warm up functions (every 5 min)
│   └── index.js                       # Executes no-op to reduce cold starts
├── tabs-portal/                       # Prebuilt React static site for Teams Tab
│   ├── index.html
│   ├── manifest.json
│   ├── logo192.png
│   ├── logo512.png
│   └── static/...
├── teams-tab/                         # Teams app package and manifest
│   ├── public/
│   │   ├── manifest.json
│   │   ├── logo192.png
│   │   └── logo512.png
│   └── src/
│       ├── App.jsx
│       ├── TicketsTab.jsx
│       └── index.js
├── bot.js                             # Bot entry point (TeamsActivityHandler)
├── formatTicketUpdate.js              # Builds Adaptive Cards for ticket updates
├── openaiClient.js                    # Azure OpenAI (GPT-4o) wrapper
├── retrievalClient.js                 # Semantic search via embeddings + Pinecone
├── teamsIdStore.js                    # Persists Teams conversation references
├── ticketClient.js                    # Helpdesk REST client
├── package.json                       # Dependencies & scripts
└── README.md                          # This documentation
```  
fileciteturn1file0

---

## ✨ Key Features
- **AI Assistance:** Natural‑language Q&A powered by Azure OpenAI (GPT-4o) with fallback semantic retrieval via Pinecone.
- **Ticket Management:** Create, read, update, and escalate tickets directly in Teams using the internal Helpdesk API.
- **Notion Indexing:** Cron‑driven ingestion from Notion, chunking, and vector indexing for document search.
- **Proactive Notifications:**  
  - **Webhook Receiver (`api-zammad-wh/`):** HTTP trigger receiving ticket events at `/api/zammad-wh`.  
  - **Secret Validation:** Verifies `X-Zammad-Webhook-Secret` header against the `HELPDESK_WEBHOOK_SECRET` env var.  
  - **Event Queueing:** Enqueues validated events to Azure Service Bus for processing.  
  - **Formatting:** `formatTicketUpdate.js` transforms raw events into Teams Adaptive Cards.  
  - **Conversation Store:** `teamsIdStore.js` persists and retrieves Teams conversation references.  
  - **Proactive Messaging:** Bot Framework continues the conversation to push updates into Teams channels.

---

## ⚙️ Environment Variables
Create a `.env` file in the project root with:

```dotenv
# Bot Framework
MicrosoftAppId=
MicrosoftAppPassword=
PING_URL=

# Helpdesk Integration
HELPDESK_API_URL=
HELPDESK_TOKEN=
HELPESK_DEFAULT_GROUP=
HELPDESK_WEB_URL=
HELPDESK_WEBHOOK_SECRET=        # Secret for validating Zammad webhook calls

# Notion & Ingestion
NOTION_TOKEN=
PINECONE_API_KEY=
PINECONE_INDEX_NAME=
AZURE_STORAGE_CONNECTION_STRING=
BLOB_RAW_NAME=
BLOB_EXTRACTED_NAME=
COMPUTER_VISION_ENDPOINT=
COMPUTER_VISION_KEY=
DI_ENDPOINT=
DI_KEY=

# Azure OpenAI & Embeddings
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_KEY=
AZURE_OPENAI_API_VERSION=
AZURE_OPENAI_DEPLOYMENT_ID=
AZURE_EMBEDDING_DEPLOYMENT_ID=
```

---

## 🔧 Zammad Webhook Configuration
To configure Zammad to send ticket events to the bot:

1. **URL:**  
   `https://newlinker-fn.azurewebsites.net/api-zammad-wh`  
2. **Method:** `POST`  
3. **HTTP Headers:**  
   - `Content-Type: application/json`  
   - `X-Zammad-Webhook-Secret: ${HELPDESK_WEBHOOK_SECRET}`  
4. **Trigger Events:** Select ticket create, update, and close triggers.  
5. **Save and Test:**  

```bash
curl -X POST https://newlinker-fn.azurewebsites.net/api-zammad-wh   -H "Content-Type: application/json"   -H "X-Zammad-Webhook-Secret: ${HELPDESK_WEBHOOK_SECRET}"   -d '{"ticket": {"id":123, "state":"closed", "title":"Issue Example"}}'
```

---

## 🚀 Data Flow (Mermaid)
```mermaid
flowchart TD
  subgraph BotWorkflow
    U[User in Teams] --> M[/api/messages]
    M --> C{Command?}
    C -- Yes --> T[ticketClient.js]
    T --> H[Helpdesk API]
    H --> R[Bot Response]
    C -- No --> O[openaiClient.js]
    O --> S{Confidence?}
    S -- High --> G[GPT Response]
    S -- Low --> L[retrievalClient.js]
    L --> P[Pinecone] --> G
  end

  subgraph NotificationWebhook
    Z[Zammad Webhook POST] --> W[api-zammad-wh/index.js]
    W --> V[Validate Secret]
    V --> Q[Enqueue to Service Bus]
    Q --> F[scheduleNotifications / Processor]
    F --> Y[formatTicketUpdate.js]
    Y --> B[Bot Framework sendProactive]
    B --> Cn[Teams via teamsIdStore]
  end

  subgraph NotionIngestion
    N[ingest-notion/index.js] --> NotionAPI[Notion API]
    NotionAPI --> Chunk[Chunk & Vectorize]
    Chunk --> Pinecone[Index]
  end
```

---

## 🛠️ Installation & Deployment

1. **Clone & Install Dependencies**  
   ```bash
   git clone https://github.com/NewlinkG/TeamsBot.git
   cd TeamsBot
   npm install (Optional)
   ```

2. **Azure Functions management URL**  
   ```bash
   https://portal.azure.com/#@newlink-group.com/resource/subscriptions/b2fe92c5-6dc2-4279-864d-841251a4f130/resourceGroups/TeamsBot/providers/Microsoft.Web/sites/newlinker-fn/appServices
   ```

3. **Deploy Functions**  
   ```bash
   cd api-zammad-wh && func azure functionapp publish newlinker-fn
   cd ../api-messages  && func azure functionapp publish newlinker-fn
   cd ../api-tabs      && func azure functionapp publish newlinker-fn
   cd ../api-tickets   && func azure functionapp publish newlinker-fn
   cd ../api-keepalive && func azure functionapp publish newlinker-fn
   cd ../warmup-ping   && func azure functionapp publish newlinker-fn
   ```

4. **Packaging Teams App**  
   ```bash
   npx create-react-app teams-tab
   cd teams-tab
   npm install @microsoft/teams-js axios
   npm run build
   xcopy.exe .\build\* ..\tabs-portal\ /S 
   ```

---

## ⚙️ Module Versions
```json
{
  "botbuilder": "^4.23.2",
  "botframework-connector": "^4.23.2",
  "axios": "^1.6.2",
  "dotenv": "^16.3.1",
  "openai": "^4.96.2",
  "@notionhq/client": "^3.0.0",
  "@azure/storage-blob": "^12.14.0",
  "@azure/cognitiveservices-computervision": "^8.2.0",
  "@azure/ms-rest-js": "^2.4.2",
  "@pinecone-database/pinecone": "^6.0.0",
  "node-fetch": "^2.6.12",
  "@azure-rest/ai-document-intelligence": "^1.0.0",
  "@microsoft/microsoft-graph-client": "^3.0.4",
  "isomorphic-fetch": "^3.0.0"
}
```

## 📋 Technical Components Overview

- **bot.js**  
  - Extends `TeamsActivityHandler`.  
  - Orchestrates routing of incoming Teams messages to internal modules.

- **openaiClient.js**  
  - Uses Azure GPT-4o for text generation.  
  - Takes into account conversation context and per-user history.

- **retrievalClient.js**  
  - Runs embedding generation and vector search.  
  - Requires Pinecone (or a similar vector database).

- **ticketClient.js**  
  - Performs CRUD operations on Helpdesk tickets.  
  - Encapsulates authentication, error handling, and data validation.

- **ingest-notion/**  
  - Runs as a cronjob.  
  - Indexes new Notion pages, detects updates, and syncs them to Pinecone.

- **api-messages/, api-tabs/, api-tickets/**  
  - HTTP triggers (Azure Functions or Express).  
  - Act as RESTful entry points into the system.

- **api-zammad-wh/**  
  - HTTP trigger endpoint for Zammad webhooks (`POST /api/zammad-wh`).  
  - Validates `X-Zammad-Webhook-Secret` header against `HELPDESK_WEBHOOK_SECRET`.  
  - Enqueues ticket events into Azure Service Bus for downstream processing.  
  - Handed off to `formatTicketUpdate.js` to build Adaptive Cards for proactive notifications.

- **tabs-portal/**  
  - React application built with Vite.  
  - Responsive design fully integrated into Teams.  
  - Hosted as static content in Azure Storage.


---

## 🔄 CI/CD
- **GitHub Actions:** `.github/workflows/main_newlinker-fn.yml`  
  - On push to `main`, builds and deploys Azure Functions and static tab.  
- **Deploy Targets:** Azure Function App for APIs, Azure Storage for static tab.

---

## 📬 Support
For technical assistance: [help@newlink-group.com](mailto:help@newlink-group.com)
