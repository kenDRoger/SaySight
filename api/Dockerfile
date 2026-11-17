FROM node:24-alpine
WORKDIR /app
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "dev"]
