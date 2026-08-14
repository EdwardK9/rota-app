FROM node:18-alpine
# Set timezone so shift times and date calculations match UK local time
RUN apk add --no-cache tzdata
ENV TZ=Europe/London
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY *.js ./
COPY public/ ./public/
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
