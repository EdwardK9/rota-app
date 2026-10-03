# Node 22 (LTS). Node 18 stopped getting security fixes in April 2025.
FROM node:22-alpine
# Set timezone so shift times and date calculations match UK local time
RUN apk add --no-cache tzdata
ENV TZ=Europe/London
WORKDIR /app
COPY package*.json ./
# better-sqlite3 is a native module: npm uses a prebuilt binary when there is
# one for this Node/Alpine combination, and compiles it otherwise — so the
# compiler is installed for the install step only and removed straight after.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm install --omit=dev \
 && apk del .build-deps
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
