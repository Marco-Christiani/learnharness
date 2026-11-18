{
  description = "LearnHarness local development";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    runtime = [pkgs.nodejs_26 pkgs.python3 pkgs.gnumake pkgs.gcc pkgs.pkg-config pkgs.git pkgs.coreutils];
    dev = pkgs.writeShellApplication {
      name = "learnharness-dev";
      runtimeInputs = runtime;
      text = ''
        if [[ ! -f package.json ]] || [[ ! -f core-plugins.json ]]; then
          echo 'Run from the LearnHarness checkout.' >&2
          exit 1
        fi
        export LH_DATA_DIR="''${LH_DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/data}"
        export LH_AUTH_FILE="''${LH_AUTH_FILE:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/auth.json}"
        mkdir -p "$LH_DATA_DIR" "$(dirname "$LH_AUTH_FILE")"
        if [[ ! -d node_modules ]]; then npm ci; fi
        npm run plugins:setup
        exec npm run dev -- -H 127.0.0.1 "$@"
      '';
    };
    lib = pkgs.lib;
    nodejs = pkgs.nodejs_26;
    # each plugin keeps its own lockfile; npm resolves the generated .sdk link offline
    pluginDeps = lib.mapAttrs (name: hash: pkgs.fetchNpmDeps {
      name = "learnharness-plugin-${name}-npm-deps";
      src = ./plugins/${name};
      inherit hash;
    }) {
      coding-questions = "sha256-NWIHJiToak9X1qyMNSlZtMjyFatgIs0RHqmS0QcXzdo=";
      drawing-pad = "sha256-zMTb53SFM4ZQT30ktIu7s+DwqYL1QCN6Mg3ZtF5aCfw=";
      flashcards = "sha256-AGjSn0TFK8jx3VpgAROg9fjhZ7gT6CKBD6vr+FbZJKE=";
      rich-code-blocks = "sha256-/jyfBWOCuludfG1Hg3bXCUqMttXeABe0vt/paW5sSyY=";
      ui-showcase = "sha256-WnG+nUQjvVBnjLRcXwlGq0ubRjBiJoX5ZUvoDWtx+CI=";
    };
    # the standalone Next server, built offline in the sandbox
    server = pkgs.buildNpmPackage {
      pname = "learnharness-server";
      version = (lib.importJSON ./package.json).version;
      src = ./.;
      inherit nodejs;
      npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
      npmConfigHook = pkgs.importNpmLock.npmConfigHook;
      nativeBuildInputs = [pkgs.autoPatchelfHook];
      buildInputs = [pkgs.stdenv.cc.cc.lib];
      # musl builds of prebuilt native modules ship alongside the glibc ones and are never loaded
      autoPatchelfIgnoreMissingDeps = ["libc.musl-x86_64.so.1"];
      env = {
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        NEXT_TELEMETRY_DISABLED = "1";
      };
      buildPhase = ''
        runHook preBuild
        export npm_config_cache="$TMPDIR/plugin-npm-cache"
        mkdir -p "$npm_config_cache"
        ${lib.concatMapStringsSep "\n" (deps: ''cp -r --no-preserve=mode ${deps}/. "$npm_config_cache"/'') (lib.attrValues pluginDeps)}
        npm run plugins:setup
        scratch=$(mktemp -d)
        mkdir -p "$scratch/data"
        printf '{}\n' > "$scratch/auth.json"
        LH_DATA_DIR="$scratch/data" LH_AUTH_FILE="$scratch/auth.json" npm run build
        LH_DATA_DIR="$scratch/data" LH_AUTH_FILE="$scratch/auth.json" node scripts/build-server.mjs
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p "$out/share"
        cp -r .next/standalone "$out/share/learnharness"
        runHook postInstall
      '';
    };
    production = pkgs.writeShellApplication {
      name = "learnharness-production";
      runtimeInputs = [nodejs pkgs.coreutils];
      text = ''
        if (( $# > 0 )); then
          echo 'Usage: PORT=3017 nix run .#production' >&2
          exit 2
        fi
        export LH_DATA_DIR="''${LH_DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/data}"
        export LH_AUTH_FILE="''${LH_AUTH_FILE:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/auth.json}"
        mkdir -p "$LH_DATA_DIR" "$(dirname "$LH_AUTH_FILE")"
        export HOSTNAME=127.0.0.1
        export PORT="''${PORT:-3000}"
        exec node --env-file-if-exists=.env.local ${server}/share/learnharness/server.js
      '';
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = runtime ++ [pkgs.electron];
      ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/lib/electron";
    };
    packages.${system} = {
      default = dev;
      inherit production server;
    };
    apps.${system} = {
      default = {type = "app"; program = "${dev}/bin/learnharness-dev";};
      production = {type = "app"; program = "${production}/bin/learnharness-production";};
    };
  };
}
