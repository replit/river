{
  description = "It's like tRPC but... with JSON Schema Support, duplex streaming and support for service multiplexing. Transport agnostic!";

  inputs.nixpkgs.url = "github:nixos/nixpkgs?rev=911ad1e67f458b6bcf0278fa85e33bb9924fed7e";

  outputs = { self, nixpkgs }:
  let
    mkDevShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
      customNodePackages = pkgs.callPackage ./nix/node-packages/default.nix {
        nodejs = pkgs.nodejs_20;
      };
    in
    pkgs.mkShell {
      nativeBuildInputs = with pkgs; [
        nodePackages.typescript-language-server
        nodejs_20
        node2nix
        customNodePackages."pnpm-8.10.2"
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
