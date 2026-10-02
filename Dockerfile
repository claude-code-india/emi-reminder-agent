# Mock Customer/Payment API for the Razorpay autopay-recovery voice agent.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

# tsx and typescript are devDependencies but are needed at runtime (npm start uses tsx).
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY --chown=node:node . .

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

CMD ["npm", "run", "start"]
