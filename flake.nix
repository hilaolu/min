{
  description = "Development environment with Node.js";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        fhsEnv = pkgs.buildFHSUserEnv {
          name = "fhs-env";
          targetPkgs = pkgs: with pkgs; [
            nodejs_20
          ];
          runScript = "bash";
        };
      in {
        devShells = {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_20
            ];
          };
          fhs = fhsEnv.env;
        };
      }
    );
}
