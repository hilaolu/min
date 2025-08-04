{
  description = "Development environment with Node.js";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        minBrowser = pkgs.callPackage ./package.nix { };
      in {
        packages = {
          default = minBrowser;
          min = minBrowser;
        };
        devShells.default =
          pkgs.mkShell { buildInputs = with pkgs; [ nodejs_20 electron ]; };
      });
}
