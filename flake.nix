{
  description = "LearnHarness local development";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    runtime = [pkgs.nodejs_26 pkgs.python3 pkgs.gnumake pkgs.gcc pkgs.pkg-config pkgs.git];
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
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = runtime ++ [pkgs.electron];
      ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/lib/electron";
    };
    packages.${system}.default = dev;
    apps.${system}.default = {type = "app"; program = "${dev}/bin/learnharness-dev";};
  };
}
