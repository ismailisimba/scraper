# Puppeteer Service

## Overview
Puppeteer Service is a microservice designed to perform various web automation tasks using Puppeteer. It is optimized for deployment on Google Cloud Run and supports tasks such as performance audits, accessibility checks, JavaScript error detection, broken link validation, and more.

## Features
- **Performance Audits**: Uses Lighthouse to evaluate the performance of web pages.
- **Accessibility Checks**: Runs Axe Core to identify accessibility violations.
- **JavaScript Error Detection**: Captures console errors and uncaught exceptions.
- **Broken Link Validation**: Detects broken links on web pages.
- **Snapshots**: Captures screenshots and PDFs of web pages.
- **Scheduled Actions**: Automates user interactions on web pages.

## Prerequisites
- Node.js >= 20.0.0
- Google Cloud Storage bucket for storing snapshots and reports.
- Google Chrome installed in the container.

## Installation
1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd puppeteer-service
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```

## Usage
### Start the Service
Run the service locally:
```bash
npm start
```

The service will be available at `http://localhost:8080`.

### API Endpoints
#### `POST /api/v1/task/:taskName`
Executes a specific task on the provided URL.

**Request Body:**
```json
{
  "url": "https://example.com",
  "actionConfig": {},
  "monitorId": "monitor123",
  "userId": "user456"
}
```

**Supported Tasks:**
- `performance`: Runs a performance audit using Lighthouse.
- `accessibility`: Checks for accessibility violations using Axe Core.
- `js-errors`: Captures JavaScript errors on the page.
- `brokenLinks`: Validates all links on the page.
- `snapshot`: Captures a screenshot and PDF of the page.
- `scheduled-actions`: Executes a series of user-defined actions on the page.

### Environment Variables
- `PORT`: The port the service listens on (default: `8080`).
- `GCS_BUCKET`: Google Cloud Storage bucket name for storing files.
- `NODE_ENV`: Set to `production` for production environments.

## Deployment
### Google Cloud Run
1. Build and push the Docker image:
   ```bash
   docker build -t gcr.io/<project-id>/puppeteer-service .
   docker push gcr.io/<project-id>/puppeteer-service
   ```
2. Deploy to Cloud Run:
   ```bash
   gcloud run deploy puppeteer-service \
       --image gcr.io/<project-id>/puppeteer-service \
       --platform managed \
       --allow-unauthenticated \
       --region <region>
   ```

## Development
### Run Locally
1. Install dependencies:
   ```bash
   npm ci
   ```
2. Start the service:
   ```bash
   npm start
   ```

### Run Tests
Currently, no tests are defined.

## License
ISC