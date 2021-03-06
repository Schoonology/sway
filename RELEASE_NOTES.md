## Release Notes

### v0.3.0 (2015-09-18)

* Updated json-refs for service/web worker support *(Issues #22)*
* Updated z-schema to avoid throwing runtime errors on unknown formats *(Issues #20)*

### v0.2.3 (2015-08-31)

* Updated json-refs to fix a big bug in local reference resolution for remote documents *(See [json-refs/issues/30](https://github.com/whitlockjc/json-refs/issues/30))*

### v0.2.2 (2015-08-31)

* Fix a bug where missing `securityDefinitions` could result in a runtime error

### v0.2.1 (2015-08-26)

* Fix bug with loading relative references *(Issue #17)*
* Fix bug with loading YAML references *(Issue #17)*
* Make errors in `SwaggerApi#create` handleable *(Issue #16)*

### v0.2.0 (2015-08-25)

* Added `Path` object, `SwaggerApi#getPath(reqOrPath)` and `SwaggerApi#getPaths()`

### v0.1.0 (2015-08-12)

* Initial release
