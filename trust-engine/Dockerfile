FROM node:22-alpine

WORKDIR /app

COPY package*.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY trust-engine/package.json trust-engine/package.json
COPY api/package.json api/package.json
COPY ingestion/package.json ingestion/package.json
COPY score-calculator/package.json score-calculator/package.json

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY packages/shared packages/shared
COPY trust-engine trust-engine
COPY db db

RUN npm -w @8004/shared run build && npm -w @8004/trust-engine run build

ENV NODE_ENV=production
CMD ["npm", "-w", "@8004/trust-engine", "run", "start"]
