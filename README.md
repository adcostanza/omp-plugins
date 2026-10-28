# omp-plugins

Extensions and skills for [omp](https://omp.sh), published as an omp marketplace.

```sh
omp plugin marketplace add adcostanza/omp-plugins
omp plugin install <plugin>@adcostanza
```

| Plugin | What it does |
| --- | --- |
| [offload](plugins/offload/) | `/offload [goal]` drops earlier conversation from the model's active context in the same session, keeps the latest exchange, and lets the model search the rest with `offloaded_history`. |
