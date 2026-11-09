import json

from birbcrew.execution.contract import (
    EXECUTION_RESULT,
    PUBLICATION_RESULT,
    ExecutionInput,
    GoalOffer,
    PublicationInput,
    ReviewInput,
    ReviewReceipt,
)


def schemas():
    return {
        "schema_version": "birbcrew.execution.v1",
        "offer": GoalOffer.model_json_schema(),
        "author_input": ExecutionInput.model_json_schema(),
        "author_result": EXECUTION_RESULT.json_schema(),
        "review_input": ReviewInput.model_json_schema(),
        "review_result": ReviewReceipt.model_json_schema(),
        "publish_input": PublicationInput.model_json_schema(),
        "publish_result": PUBLICATION_RESULT.json_schema(),
    }


if __name__ == "__main__":
    print(json.dumps(schemas(), sort_keys=True, indent=2))
