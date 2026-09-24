{
  description = "Stackma: Firefox 156 related-tab stacks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      nixpkgs,
      ...
    }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
          system:
          f {
            pkgs = import nixpkgs { inherit system; };
          }
        );
    in
    {
      formatter = forAllSystems ({ pkgs }: pkgs.nixfmt);
      devShells = forAllSystems (
        { pkgs }:
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs_24
              geckodriver
              zip
              gitMinimal
              nixfmt
              actionlint
              zizmor
              shellcheck
            ];
          };
          release = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs_24
              gitMinimal
              gh
            ];
          };
        }
      );
    };
}
