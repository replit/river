{
  description = "It's like tRPC but... with JSON Schema Support, duplex streaming and support for service multiplexing. Transport agnostic!";

  inputs.nixpkgs.url = "github:nixos/nixpkgs";

  outputs = { self, nixpkgs }:
  let
    mkDevShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      nativeBuildInputs = with pkgs; [
        nodejs
        nodePackages.typescript-language-server
      ];
    };
  in
  {
    devShells.aarch64-linux.default = mkDevShell "aarch64-linux";
    devShells.aarch64-darwin.default = mkDevShell "aarch64-darwin";
    devShells.x86_64-linux.default = mkDevShell "x86_64-linux";
    devShells.x86_64-darwin.default = mkDevShell "x86_64-darwin";
  };
}
