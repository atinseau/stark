#/bin/bash

# Run test with a specific test name pattern


test() {
    test_file="$1"
    test_name_pattern="$2"
    local output
    output=$(script -q /dev/null bun test $test_file --test-name-pattern="^${test_name_pattern}$" 2>&1 | grep -v "bun test")
    local result_line
    result_line=$(echo "$output" | grep -iE "pass|fail")
    local filtered_output
    filtered_output=$(echo "$output" | grep -viE "pass|fail|filtered out|across" | grep -v "$test_file")
    echo "$filtered_output"
}



list_tests_in_file() {
    test_file="$1"

    tr '\n' ' ' < "$test_file" \
    | grep -Eo "it(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*['\"\`]([^'\"\`]+)['\"\`]" \
    | grep -Eo "['\"\`]([^'\"\`]+)['\"\`]" \
    | tr -d "'\"\`"
}


ARGS=("$@")
BATCH_SIZE=5
TEST_FILES=()
TEST_NAME_PATTERN=""

for arg in "${ARGS[@]}"; do
    # Add condition to extract configuration from the argument
    if [[ "$arg" == "--batch-size="* ]]; then
        BATCH_SIZE="${arg#*=}"
    elif [[ "$arg" == "--test-name-pattern="* ]]; then
        TEST_NAME_PATTERN="${arg#*=}"
    else
        TEST_FILES+=("$arg")
    fi
done


if [ ${#TEST_FILES[@]} -eq 0 ]; then
    echo -e "No test files provided.\n\nUsage: $0 [--batch-size=N] [--test-name-pattern=PATTERN] test_file1 test_file2 ..."
    exit 1
fi

for test_file in "${TEST_FILES[@]}"; do
    if [ ! -f "$test_file" ]; then
        echo "Test file '$test_file' does not exist."
        exit 1
    fi

    echo "$test_file"
    echo "-----------------------------"
    mapfile -t test_names < <(list_tests_in_file "$test_file")

    for test_name in "${test_names[@]}"; do
        test "$test_file" "$test_name"
    done
done
