FROM node:20-alpine

WORKDIR /runner

# Tools needed for DNS/HTTP diagnostics + routing visibility
RUN apk add --no-cache curl bind-tools libc-utils iproute2

# Install deps
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY . .

# Entrypoint does startup DNS checks before running the app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /runner/debug-dns.sh

ENTRYPOINT ["/entrypoint.sh"]

# Default command
CMD ["npm", "run", "start"]
