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
    production = pkgs.writeShellApplication {
      name = "learnharness-production";
      runtimeInputs = runtime;
      text = ''
        if (( $# > 0 )); then
          echo 'Usage: PORT=3017 nix run .#production' >&2
          exit 2
        fi
        if [[ ! -f package.json ]] || [[ ! -f core-plugins.json ]]; then
          echo 'Run from the LearnHarness checkout.' >&2
          exit 1
        fi
        export LH_DATA_DIR="''${LH_DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/data}"
        export LH_AUTH_FILE="''${LH_AUTH_FILE:-''${XDG_DATA_HOME:-$HOME/.local/share}/learnharness-fork/auth.json}"
        mkdir -p "$LH_DATA_DIR" "$(dirname "$LH_AUTH_FILE")"
        if [[ ! -d node_modules ]]; then npm ci --ignore-scripts; fi
        npm run plugins:setup
        lh_build_scratch=$(mktemp -d)
        trap 'rm -rf -- "$lh_build_scratch"' EXIT
        mkdir -p "$lh_build_scratch/data"
        printf '{}\n' > "$lh_build_scratch/auth.json"
        LH_DATA_DIR="$lh_build_scratch/data" LH_AUTH_FILE="$lh_build_scratch/auth.json" npm run build
        LH_DATA_DIR="$lh_build_scratch/data" LH_AUTH_FILE="$lh_build_scratch/auth.json" node scripts/build-server.mjs
        rm -rf -- "$lh_build_scratch"
        trap - EXIT
        export HOSTNAME=127.0.0.1
        export PORT="''${PORT:-3000}"
        exec node --env-file-if-exists=.env.local .next/standalone/server.js
      '';
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = runtime ++ [pkgs.electron];
      ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/lib/electron";
    };
    packages.${system} = {
      default = dev;
      inherit production;
    };
    apps.${system} = {
      default = {type = "app"; program = "${dev}/bin/learnharness-dev";};
      production = {type = "app"; program = "${production}/bin/learnharness-production";};
    };
  };
}
