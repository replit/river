{
  description = "It's like tRPC but... with JSON Schema Support, duplex streaming and support for service multiplexing. Transport agnostic!";

  inputs.nixpkgs.url = "github:nixos/nixpkgs";

  # sbt builder used to package UCLID5 (the PVerifier proof backend).
  inputs.sbt-derivation = {
    url = "github:zaninime/sbt-derivation";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, sbt-derivation }:
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

    # The P model checker (github.com/p-org/P), used by verification/p.
    mkP = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.buildDotnetGlobalTool {
      pname = "p";
      version = "3.1.0";
      nugetSha256 = "sha256-sqIS47GvG/L9ybgImdopAdZiXRouR41HjjACiHKkvcE=";
      dotnet-sdk = pkgs.dotnet-sdk_8;
      dotnet-runtime = pkgs.dotnet-sdk_8;
      meta.mainProgram = "p";
    };

    # UCLID5, the SMT-based verifier that `p compile --mode verification`
    # (PVerifier) shells out to. Only prebuilt from source: the released
    # uclid 0.9.5 zip predates the `datatype` syntax PVerifier emits, so we
    # pin a recent master commit. uclid expects the z3 4.12 Java bindings as
    # an unmanaged jar in lib/ (see its get-z3-linux.sh) and `z3` + the JNI
    # library at runtime.
    mkUclid = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
      z3j = pkgs.z3_4_12.override { javaBindings = true; jdk = pkgs.jdk11; };
    in
    sbt-derivation.lib.mkSbtDerivation {
      inherit pkgs;
      # uclid pins sbt 1.4.9, whose launcher needs a pre-Security-Manager-
      # removal JDK
      overrides.sbt = pkgs.sbt.override { jre = pkgs.jdk11; };
      pname = "uclid";
      version = "unstable-2025-07-09";
      src = pkgs.fetchFromGitHub {
        owner = "uclid-org";
        repo = "uclid";
        rev = "a4e4e7a22780833c86d6a650af2fcf88a7d00a06";
        hash = "sha256-c9oUaHcNbICJC1oWYlhE86dZtK+WaW2ZtotDWW9l2U4=";
      };
      depsSha256 = "sha256-Zxl06xUzOOp1elaFvrQjKYERjCXZXB/A891/QuqEFA0=";
      nativeBuildInputs = [ pkgs.makeWrapper ];
      buildPhase = ''
        mkdir -p lib
        cp ${z3j.java}/share/java/com.microsoft.z3.jar lib/
        sbt stage
      '';
      installPhase = ''
        mkdir -p $out
        cp -r target/universal/stage/* $out/
        wrapProgram $out/bin/uclid \
          --prefix PATH : ${pkgs.jre}/bin \
          --prefix PATH : ${pkgs.z3_4_12}/bin \
          --prefix LD_LIBRARY_PATH : ${z3j.lib}/lib
      '';
      meta.mainProgram = "uclid";
    };

    # PObserve: P's runtime-monitoring framework (compiled P spec machines
    # checked against real execution logs). Not published to Maven Central, so
    # we build the three plain-Java modules (Commons, RegressionTesting, the
    # CLI) straight from the P repo sources with javac — their gradle files
    # only add linting/publishing plugins. Lombok runs as an annotation
    # processor. The dependency jars are pinned individually from Maven
    # Central.
    mkPObserve = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
      fetchJar = name: url: hash: pkgs.fetchurl { inherit name url hash; };
      depJars = [
        (fetchJar "jcommander-1.82.jar" "https://repo1.maven.org/maven2/com/beust/jcommander/1.82/jcommander-1.82.jar" "sha256-3urBV8jeaCKHjYXQx7yEZ6GcyEhNN3iPeATwOd3igLE=")
        (fetchJar "jackson-annotations-2.16.1.jar" "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-annotations/2.16.1/jackson-annotations-2.16.1.jar" "sha256-pHMHceakld03k6Qs24zmvduWx34V9AyY/Y2aeuCecoY=")
        (fetchJar "jackson-core-2.16.1.jar" "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-core/2.16.1/jackson-core-2.16.1.jar" "sha256-9fjvkGCeZP7ILrkI5JfcfYGy65g/5Qm4cCkqGTzeTfs=")
        (fetchJar "jackson-databind-2.16.1.jar" "https://repo1.maven.org/maven2/com/fasterxml/jackson/core/jackson-databind/2.16.1/jackson-databind-2.16.1.jar" "sha256-uvio6+6PRe9ozdXi3Tkjs+KWwJN7luwLSAaqOjG8zR0=")
        (fetchJar "findbugs-annotations-3.0.1.jar" "https://repo1.maven.org/maven2/com/google/code/findbugs/annotations/3.0.1/annotations-3.0.1.jar" "sha256-a0f/Cm3gzhfL7cOrsIKMpbzjAJ1T6kezcj/wI8R0L3k=")
        (fetchJar "log4j-api-2.20.0.jar" "https://repo1.maven.org/maven2/org/apache/logging/log4j/log4j-api/2.20.0/log4j-api-2.20.0.jar" "sha256-L0PupnnqZvFMoPE/7CqGAKwST1pSMdy034OT7dy5dVA=")
        (fetchJar "log4j-core-2.20.0.jar" "https://repo1.maven.org/maven2/org/apache/logging/log4j/log4j-core/2.20.0/log4j-core-2.20.0.jar" "sha256-YTffhIza7Z9NUHb3VRPGyF2oC5U/TnrMo4CYt3B2P1U=")
        (fetchJar "json-simple-1.1.1.jar" "https://repo1.maven.org/maven2/com/googlecode/json-simple/json-simple/1.1.1/json-simple-1.1.1.jar" "sha256-TmlpaJK4i0HFXUmrL9zCHurZK/VKzFiMAFBZbDt1GZw=")
        (fetchJar "fst-2.50.jar" "https://repo1.maven.org/maven2/de/ruedigermoeller/fst/2.50/fst-2.50.jar" "sha256-tq5bkNWCUHDS+CrGFBcJD86O1+VjSKPoaiAmd06LpWo=")
        (fetchJar "objenesis-2.5.1.jar" "https://repo1.maven.org/maven2/org/objenesis/objenesis/2.5.1/objenesis-2.5.1.jar" "sha256-sEPwPkZnUvfwPiMmo7E6SbfGSfjyotyHcVgn4k9z2cY=")
        (fetchJar "javassist-3.21.0-GA.jar" "https://repo1.maven.org/maven2/org/javassist/javassist/3.21.0-GA/javassist-3.21.0-GA.jar" "sha256-eqWeAx+UGYSvB9rMbKhebcm9OkhemqJJTLwDTvoSJdA=")
        (fetchJar "awssdk-annotations-2.29.15.jar" "https://repo1.maven.org/maven2/software/amazon/awssdk/annotations/2.29.15/annotations-2.29.15.jar" "sha256-H9gLfpoqFOjRsCbpDYaLhiopuxXtmiLyAnmb+8rRgH4=")
        (fetchJar "awssdk-regions-2.29.15.jar" "https://repo1.maven.org/maven2/software/amazon/awssdk/regions/2.29.15/regions-2.29.15.jar" "sha256-vg8V7XPtFx97yM3mh3lpcI11A/QLj+WfhteqlZqoG8c=")
        (fetchJar "awssdk-utils-2.29.15.jar" "https://repo1.maven.org/maven2/software/amazon/awssdk/utils/2.29.15/utils-2.29.15.jar" "sha256-XP6qaDlVOF9O3FHqj7sydWsPpaimtSNw6L0JN9uSvoY=")
        (fetchJar "validation-api-2.0.1.Final.jar" "https://repo1.maven.org/maven2/javax/validation/validation-api/2.0.1.Final/validation-api-2.0.1.Final.jar" "sha256-mHO0bfGDPJ7o9bwf9oUzdRFdrdiJe8taDf+1hIg17mw=")
      ];
      lombok = fetchJar "lombok-1.18.30.jar" "https://repo1.maven.org/maven2/org/projectlombok/lombok/1.18.30/lombok-1.18.30.jar" "sha256-FBUbR1gtVwtN4WoUfs4729GazkruW946VXjIfbnsuZg=";
    in
    pkgs.stdenv.mkDerivation {
      pname = "pobserve";
      version = "1.0.0-p3.1.0";
      src = pkgs.fetchFromGitHub {
        owner = "p-org";
        repo = "P";
        rev = "857776015de5f2683f11945728a1dc57f4b74b33"; # the P 3.1.0 release commit
        hash = "sha256-5YJ+YY20pqNKd4Z7tuqa8+HAHSG1e2NyqqAdyf0ExQ0=";
      };
      nativeBuildInputs = [ pkgs.jdk17 pkgs.makeWrapper pkgs.strip-nondeterminism ];
      buildPhase = ''
        runHook preBuild
        cp ${lombok} lombok.jar
        depcp=$(echo ${pkgs.lib.concatMapStringsSep ":" toString depJars})
        mkdir -p classes
        find Src/PObserve/PObserveCommons/src/main/java Src/PObserve/PObserve/src/main/java -name '*.java' > sources.txt
        javac -cp "$depcp:lombok.jar" -processorpath lombok.jar               -d classes @sources.txt
        cp -r Src/PObserve/PObserve/src/main/resources/* classes/ 2>/dev/null || true
        jar cf pobserve.jar -C classes .
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p $out/share/java $out/bin
        cp pobserve.jar $out/share/java/
        strip-nondeterminism --type jar $out/share/java/pobserve.jar || true
        depcp=$(echo ${pkgs.lib.concatMapStringsSep ":" toString depJars})
        makeWrapper ${pkgs.jdk17}/bin/java $out/bin/pobserve           --add-flags "-cp $out/share/java/pobserve.jar:$depcp pobserve.PObserve"
        # the compile classpath, for building spec/parser jars against pobserve
        echo "$out/share/java/pobserve.jar:$depcp" > $out/share/java/classpath.txt
        runHook postInstall
      '';
      meta.mainProgram = "pobserve";
    };

    # `p compile`/`p check` shell out to `dotnet build` at runtime, so the
    # SDK itself must be on PATH alongside the tool. JDK 17 + Maven power the
    # PEx exhaustive-checking backend (`p compile --mode pex`); uclid powers
    # the PVerifier proof backend (`p compile --mode verification`).
    mkVerificationShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      nativeBuildInputs = [
        (mkP system)
        (mkUclid system)
        (mkPObserve system)
        pkgs.dotnet-sdk_8
        pkgs.jdk17
        pkgs.maven
        pkgs.kotlin
      ];
      POBSERVE_HOME = mkPObserve system;
      DOTNET_CLI_TELEMETRY_OPTOUT = "1";
    };
  in
  {
    devShells.aarch64-linux.default = mkDevShell "aarch64-linux";
    devShells.aarch64-darwin.default = mkDevShell "aarch64-darwin";
    devShells.x86_64-linux.default = mkDevShell "x86_64-linux";
    devShells.x86_64-darwin.default = mkDevShell "x86_64-darwin";

    packages.aarch64-linux.p = mkP "aarch64-linux";
    packages.aarch64-darwin.p = mkP "aarch64-darwin";
    packages.x86_64-linux.p = mkP "x86_64-linux";
    packages.x86_64-darwin.p = mkP "x86_64-darwin";

    packages.aarch64-linux.pobserve = mkPObserve "aarch64-linux";
    packages.aarch64-darwin.pobserve = mkPObserve "aarch64-darwin";
    packages.x86_64-linux.pobserve = mkPObserve "x86_64-linux";
    packages.x86_64-darwin.pobserve = mkPObserve "x86_64-darwin";

    packages.aarch64-linux.uclid = mkUclid "aarch64-linux";
    packages.aarch64-darwin.uclid = mkUclid "aarch64-darwin";
    packages.x86_64-linux.uclid = mkUclid "x86_64-linux";
    packages.x86_64-darwin.uclid = mkUclid "x86_64-darwin";

    devShells.aarch64-linux.verification = mkVerificationShell "aarch64-linux";
    devShells.aarch64-darwin.verification = mkVerificationShell "aarch64-darwin";
    devShells.x86_64-linux.verification = mkVerificationShell "x86_64-linux";
    devShells.x86_64-darwin.verification = mkVerificationShell "x86_64-darwin";
  };
}
