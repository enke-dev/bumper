FROM node:20.11.0-alpine

ENV NODE_VERSION=20.11.0

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "index.js"]
