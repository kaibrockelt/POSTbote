# POSTBote team server: web UI + API in one static binary.
#   docker build -t postbote .
#   docker run -p 8080:8080 -v postbote-data:/data postbote

FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# workspace member; only its manifest is needed, it is not built here
COPY desktop desktop
COPY --from=web /src/web/dist web/dist
RUN cargo build --release --locked -p postbote-server && cp target/release/postbote /postbote

FROM alpine:3
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 postbote && mkdir /data && chown postbote /data
COPY --from=build /postbote /usr/local/bin/postbote
USER postbote
VOLUME /data
ENV POSTBOTE_ADDR=0.0.0.0:8080 \
    POSTBOTE_DATA=/data
EXPOSE 8080
ENTRYPOINT ["postbote"]
CMD ["serve"]
