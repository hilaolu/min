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
          targetPkgs = pkgs:
            with pkgs;
            [
              nodejs_20

              libxkbcommon # libxkbcommon.so
              at-spi2-core # libatspi.so
              mesa # libdbm.so libexpat.so
              cairo # libcairo.so
              cups # libcups.so
              gtk3 # libgtk-3.so
              pango # libpango-1.0.so
              nss # libnss3.so
              alsa-lib # libasound.so
              glib # libglib-2.0.so libgobject-2.0.so libgio.so
              stdenv.cc.cc.lib # libgcc_s.so
              udev
              nspr
              dbus
              expat
            ] ++ (with xorg; [
              libX11 # libX11.so
              libXcomposite # libXcomposite.so
              libXdamage # libXdamage.so
              libXext # libXext.so
              libXfixes # libXfixes.so
              libXrandr # libXrandr.so
              libxcb
            ]);
          runScript = "bash";
        };
      in { devShells = { default = fhsEnv.env; }; });
}
