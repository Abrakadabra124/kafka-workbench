FROM apache/kafka:4.2.2@sha256:1213eb3943d551e5ed1fca7a4e109001cee35770b66a02a0c37a8964efe09b69 AS kafka
FROM eclipse-temurin:21-jdk-jammy@sha256:4b1a74fbffbe6b4e7b6f0171a472478282fb463790a51edf10e465d578f22b69 AS compiler
WORKDIR /src
COPY --from=kafka /opt/kafka/libs/kafka-clients-*.jar /deps/
COPY Workbench.java .
RUN javac --release 17 -cp '/deps/*' -d /compiled Workbench.java
FROM kafka
COPY --from=compiler /compiled/ /opt/workbench/
