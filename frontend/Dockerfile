# Build from the repository root; shared wire declarations live in packages/contracts
# and the PDF text-order fixtures in packages/pdf-text-order.
FROM node:22-slim

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /packages/contracts
# pdfTextOrder.test.ts imports cases.json from here, and `npm run build` type
# checks the test files, so the image needs it even though it never ships.
COPY packages/pdf-text-order /packages/pdf-text-order
COPY word-addin/src /word-addin/src

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
