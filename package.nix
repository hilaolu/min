{
  lib,
  stdenv,
  fetchurl,

  dpkg,
  autoPatchelfHook,
  makeWrapper,

  libxkbcommon,
  libxcb,
  xorg,
  alsa-lib,
  nss,
  at-spi2-core,
  mesa,
  cairo,
  pango,
  cups,
  gtk3,
  glib,

  nix-update-script,
}:

stdenv.mkDerivation (finalAttrs: rec {
  pname = "min";
  version = "1.35.3";

  src = fetchurl {
    url = "https://github.com/hilaolu/min/releases/download/v${version}/min-${version}-amd64.deb";

    hash = "sha256-2NwN8stB9HBdGS0ZZr63yezwV0i4L0Du4wbAr6zTLV8=";
  };

  nativeBuildInputs = [
    dpkg
    autoPatchelfHook
  ];

  buildInputs = [
    libxkbcommon # libxkbcommon.so
    libxcb # libxcb.so
    at-spi2-core # libatspi.so
    mesa # libdbm.so libexpat.so
    cairo # libcairo.so
    cups # libcups.so
    gtk3 # libgtk-3.so
    pango # libpango-1.0.so
    (with xorg; [
      libX11 # libX11.so
      libXcomposite # libXcomposite.so
      libXdamage # libXdamage.so
      libXext # libXext.so
      libXfixes # libXfixes.so
      libXrandr # libXrandr.so
    ])
    nss # libnss3.so
    alsa-lib # libasound.so
    glib # libglib-2.0.so libgobject-2.0.so libgio.so
    stdenv.cc.cc.lib # libgcc_s.so
    makeWrapper
  ];

  unpackPhase = "
    dpkg-deb -x $src $out
    mv $out/usr/share $out
  ";

  installPhase = ''
    mkdir -p $out/bin
    makeWrapper $out/opt/Min/min $out/bin/min \
        --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform=wayland}}"
  '';

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "Fast, minimal browser that protects your privacy";
    homepage = "https://github.com/minbrowser/min";
    changelog = "https://github.com/minbrowser/min/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.asl20;
    maintainers = with lib.maintainers; [ kashw2 ];
  };
})
