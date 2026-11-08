# The P-Lens relay and ticket issuer as Bun executables, built from the
# repository's root: docker build -f hosts/bun/Dockerfile .
FROM docker.io/oven/bun:1.4.3 AS build
WORKDIR /source
COPY . .
RUN bun install --frozen-lockfile && bun --cwd=hosts/bun run compile

FROM docker.io/library/debian:bookworm-slim
COPY --from=build /source/hosts/bun/dist/ /usr/local/bin/
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin p-lens && mkdir /data && chown p-lens /data
USER p-lens
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 7780 7781
CMD ["p-lens-relay"]
