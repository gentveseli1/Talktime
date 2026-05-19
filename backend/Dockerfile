# Single-stage Dockerfile suitable for development.
# A multi-stage production image can be added in a later phase.
FROM node:20-alpine

WORKDIR /app

# Install OS deps needed by argon2 (native module) and Prisma's openssl runtime.
RUN apk add --no-cache python3 make g++ openssl wget

# Install dependencies first to leverage Docker layer cache.
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the source.
COPY . .

# Generate the Prisma client at build time so the image is ready to run.
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "dev"]
