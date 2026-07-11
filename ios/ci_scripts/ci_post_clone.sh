#!/bin/sh
# Xcode Cloud post-clone hook. Must live in ci_scripts/ next to the
# .xcodeproj and be executable, and runs before Xcode resolves the project —
# which is what lets a generated-project repo (no committed .xcodeproj)
# build on Xcode Cloud at all.
set -e

brew install xcodegen

cd "$CI_PRIMARY_REPOSITORY_PATH/ios"
xcodegen generate

# TestFlight rejects duplicate build numbers. CI_BUILD_NUMBER increases
# monotonically per Xcode Cloud build; stamp it over the placeholder
# CURRENT_PROJECT_VERSION from project.yml (-all keeps the app and the
# Share Extension in sync, which App Store validation requires).
agvtool new-version -all "$CI_BUILD_NUMBER"
