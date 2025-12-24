FROM node:20-alpine

WORKDIR /runner

# Install deps
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY . .

# Default command
CMD ["npm", "run", "start"]
