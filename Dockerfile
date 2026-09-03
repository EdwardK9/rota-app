FROM node:18-alpine
# Set timezone so shift times and date calculations match UK local time
RUN apk add --no-cache tzdata
ENV TZ=Europe/London
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY *.js ./
COPY changelog.json ./
# *.js above matches top-level files only — it does not recurse — so any server-side
# code in a subdirectory has to be copied explicitly or the image builds without it.
COPY v3/ ./v3/
COPY v5/ ./v5/
COPY public/ ./public/
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
