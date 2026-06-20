FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Install mise build dependencies for node-build (binary download path)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    xz-utils \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/jdx/mise:latest /usr/local/bin/mise /usr/local/bin/

# Activate mise in both shells
RUN echo 'eval "$(mise activate bash)"' >> /home/vscode/.bashrc && \
    echo 'eval "$(mise activate zsh)"' >> /home/vscode/.zshrc
