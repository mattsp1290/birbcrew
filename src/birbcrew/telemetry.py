import json
import os
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from pydantic_ai import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings

from birbcrew.config import settings


class LocalExporter(SpanExporter):
    def export(self, spans):
        path = settings().evidence_dir / f"telemetry-{os.getpid()}.jsonl"
        with path.open("a") as output:
            for span in spans:
                output.write(
                    json.dumps(
                        {
                            "name": span.name,
                            "trace_id": format(span.context.trace_id, "032x"),
                            "span_id": format(span.context.span_id, "016x"),
                            "attributes": dict(span.attributes or {}),
                        },
                        default=str,
                    )
                    + "\n"
                )
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass


def configure() -> None:
    provider = TracerProvider(resource=Resource.create({"service.name": "birbcrew-proof"}))
    provider.add_span_processor(SimpleSpanProcessor(LocalExporter()))
    trace.set_tracer_provider(provider)
    Agent.instrument_all(InstrumentationSettings(tracer_provider=provider, include_content=False))


@contextmanager
def observation(name: str, **ids: str):
    attributes = {f"birbcrew.{key}": value for key, value in ids.items()}
    with trace.get_tracer("birbcrew").start_as_current_span(name, attributes=attributes):
        print(json.dumps({"event": name, **ids}), flush=True)
        yield
