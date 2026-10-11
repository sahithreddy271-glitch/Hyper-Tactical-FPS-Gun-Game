FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
EXPOSE 8080/tcp
USER node
CMD ["npm", "start"]
