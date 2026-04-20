#!/bin/zsh

PLUGIN_LINK="/Users/clarkye/Library/Mobile Documents/iCloud~md~obsidian/Documents/Home/.obsidian/plugins/auto-node"
BUILD_DIR="$(dirname "$0")/build"

npm install
npm run build

if [ ! -L "$PLUGIN_LINK" ]; then
  ln -s "$BUILD_DIR" "$PLUGIN_LINK"
  echo "Symlink created."
else
  echo "Symlink already exists, skipping."
fi

npm run dev
