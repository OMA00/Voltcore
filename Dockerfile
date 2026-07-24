FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json .npmrc ./

# Set environment variables to skip engine download
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=library

RUN npm ci

COPY . .

# Generate Prisma Client without downloading engine
RUN npx prisma generate

EXPOSE 3000

# Run migrations, then start the bot
CMD ["sh", "-c", "npx prisma db push && npm start"]