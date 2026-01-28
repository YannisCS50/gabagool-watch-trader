FROM node:20-alpine

WORKDIR /runner

# Install deps
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY . .

# Direct start - no debug tooling needed
CMD ["npm", "run", "start"]
