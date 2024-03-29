import streamlit as st
import pandas as pd
import os
import json
import re

from dotenv import load_dotenv
from langchain import OpenAI

from utils import (
    create_docs_from_values,
    create_vectorstore,
    init_vectorstore,
    check_input,
    log,
    call_sql_api,
    CUBE_SQL_API_PROMPT,
    _NO_ANSWER_TEXT,
    PROMPT_POSTFIX,
)

load_dotenv()

llm = OpenAI(
    temperature=0, openai_api_key=os.environ.get("OPENAI_API_KEY"), verbose=True
)

st.title("CubeSemanticLoader on LangChain")

question = st.text_input(
    "Your question: ", placeholder="Ask me anything ...", key="input"
)

if st.button("Submit", type="primary"):
    check_input(question)
    vectorstore = init_vectorstore()

    # log("Quering vectorstore and building the prompt...")

    docs = vectorstore.similarity_search(question)
    # take the first document as the best guess
    table_name = docs[0].metadata["table_name"]

    # Columns
    columns_question = "All available columns"
    column_docs = vectorstore.similarity_search(
        columns_question, filter=dict(table_name=table_name), k=15
    )

    lines = []
    for column_doc in column_docs:
        column_title = column_doc.metadata["column_title"]
        column_name = column_doc.metadata["column_name"]
        column_data_type = column_doc.metadata["column_data_type"]
        print(column_name)
        lines.append(
            f"title: {column_title}, column name: {column_name}, datatype: {column_data_type}, member type: {column_doc.metadata['column_member_type']}"
        )
    columns = "\n\n".join(lines)

    # Construct the prompt
    prompt = CUBE_SQL_API_PROMPT.format(
        input_question=question,
        table_info=table_name,
        columns_info=columns,
        top_k=1000,
        no_answer_text=_NO_ANSWER_TEXT,
    )

    # log("Prepared prompt")

    # Call LLM API to get the SQL query
    log("Calling LLM API to generate SQL query...")
    llm_answer = llm(prompt + PROMPT_POSTFIX)
    bare_llm_answer = re.sub(r"(?i)Answer:\s*", "", llm_answer)
    print(prompt + PROMPT_POSTFIX)

    # log("Got response from LLM:")
    # st.info(bare_llm_answer)

    if llm_answer.strip() == _NO_ANSWER_TEXT:
        st.stop()

    # Parse the response
    parsed_data = json.loads(bare_llm_answer)

    # Access the objects
    sql_query = parsed_data["query"]
    filters = parsed_data["filters"]

    log("Query generated by LLM:")
    st.info(sql_query)

    if len(filters) > 0:
        # log("Query has filters:")
        # st.info(filters)

        # Handling filters for better accuracy
        # log("Processing filters for better accuracy...")
        for filter in filters:
            print(filter)
            column_name = filter["column"]
            operator = filter["operator"]
            filter_value = f"{column_name}"
            doc = vectorstore.similarity_search(
                filter["column"], filter=dict(column_name=filter_value), k=1
            )
            
            if doc:
                print("Creating docs from values...")
                value_docs = create_docs_from_values(
                    doc[0].metadata["column_values"], table_name, column_name
                )

                # Create vectorstore for values search
                print(f"{column_name}: Creating vectorstore for values search...")
                value_vectorstore = create_vectorstore(value_docs)

                # Search for the value
                print("Searching for the value...")
                value_doc = value_vectorstore.similarity_search(filter["value"], k=1)
                cleaned_value = value_doc[0].page_content

                if cleaned_value and cleaned_value != filter["value"]:
                    log("Replacing filter value with the closest match...")
                    old_filter_sql = (
                        f"{filter['column']} {filter['operator']} '{filter['value']}'"
                    )
                    new_filter_sql = (
                        f"{filter['column']} {filter['operator']} '{cleaned_value}'"
                    )
                    sql_query = sql_query.replace(old_filter_sql, new_filter_sql)
                    st.info(sql_query)

    # Call Cube SQL API
    columns, rows = call_sql_api(sql_query)
    print("Result from SQL API:")
    print(rows)

    # Display the result
    df = pd.DataFrame(rows, columns=columns)
    st.table(df)
