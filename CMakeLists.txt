cmake_minimum_required(VERSION 3.20)
project(sequitur CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# We already built and validated the media driver standalone in
# third_party/aeron/cmake-build -- no need to build it again here.
set(BUILD_AERON_DRIVER OFF CACHE BOOL "" FORCE)
set(BUILD_AERON_ARCHIVE_API OFF CACHE BOOL "" FORCE)
set(AERON_TESTS OFF CACHE BOOL "" FORCE)
set(AERON_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(AERON_SYSTEM_TESTS OFF CACHE BOOL "" FORCE)
set(AERON_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
set(AERON_BUILD_DOCUMENTATION OFF CACHE BOOL "" FORCE)

add_subdirectory(third_party/aeron)

set(AERON_CLIENT_C_DIR ${CMAKE_SOURCE_DIR}/third_party/aeron/aeron-client/src/main/c)
set(AERON_CLIENT_CPP_WRAPPER_DIR ${CMAKE_SOURCE_DIR}/third_party/aeron/aeron-client/src/main/cpp_wrapper)

# name: the executable's output name.
# path: its source directory under src/, relative to src/ (may differ from
# name, since fundamentals/simulation binaries are grouped into subfolders).
function(add_aeron_executable name path)
    add_executable(${name} src/${path}/main.cpp)
    target_include_directories(${name} PRIVATE
        ${AERON_CLIENT_C_DIR} ${AERON_CLIENT_CPP_WRAPPER_DIR} ${CMAKE_SOURCE_DIR}/include)
    target_link_libraries(${name} PRIVATE aeron_client_wrapper aeron_static)
endfunction()

# Fundamentals: the pub/sub and sequencer walkthrough.
add_aeron_executable(publisher fundamentals/publisher)
add_aeron_executable(subscriber fundamentals/subscriber)
add_aeron_executable(producer fundamentals/producer)
add_aeron_executable(consumer fundamentals/consumer)

# Shared core: the single-writer sequencer, used by both fundamentals and simulation.
add_aeron_executable(sequencer sequencer)

# Simulation: the market-making research project.
add_aeron_executable(liquidity_taker simulation/liquidity_taker)
add_aeron_executable(market_maker simulation/market_maker)
add_aeron_executable(optimal_market_maker simulation/optimal_market_maker)
