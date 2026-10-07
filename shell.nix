# Development shell: node for the tests and build (`npm test`, `npm run build`).
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22
  ];
}
