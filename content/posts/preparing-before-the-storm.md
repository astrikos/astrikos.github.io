---
title: "Preparing before the storm: Migrating our monolith into Kubernetes"
date: 2020-07-08
description: "The steps Beat’s infrastructure team took to ensure a safe and reliable transition of a monolith service into the Kubernetes world."
draft: false
tags: [Kubernetes]
---

{{< figure src="/IPWJ8JuOC38d8rjslEXrAw.jpeg" >}}

Some time ago [Beat’s](https://thebeat.co/) infrastructure team decided to invest in a [Kubernetes](https://kubernetes.io/) powered infrastructure. Like most companies, we started with hosting less significant services inside the new Kubernetes platform. Moving on, we were gradually onboarding more and more services. Finally, we decided that every new service developed would be required to run inside Kubernetes.

**Having a critical amount of microservices in our clusters already, the next logical step was to move our main backbone service, our monolith, into Kubernetes.** Having our flagship service inside Kubernetes would make our infrastructure simpler and easier to maintain. Our deployment pipelines would become more robust, our configuration more consistent with the rest of our microservices, and the overall system more reliable.

In this article, we will talk about some of the preparation work we did in our Kubernetes clusters to be able to cope with the significant load that our monolith would bring along. We hope you find this useful when you are in a similar situation.

### **Reserved resources**

One of our main objectives for this task was to **make sure our Kubernetes nodes’ functionality will not be affected by any other service deployed inside the Kubernetes.** Conveniently, kubelet has a feature named _Node Allocatable_ that helps Kubernetes cluster protect their system and Kubernetes important components by reserving compute resources.

> _Allocatable on a Kubernetes node is defined as the amount of compute resources that are available for pods._ Source: [Kubernetes documentation page](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/)

This means that we can set aside some resources for our system and the rest will be allocated to Kubernetes pods.

The first category we wanted to protect is the system critical daemons like sshd, ntpd, user management, etc. Kubelet has a specific flag for this task which looks like:

```vim {linenos=false}
--system-reserved-cgroup=system-reserved --system-reserved=cpu=500m,memory=3000Mi
```

This is translated into preserving half CPU and 3G of memory for our operating system critical components, which we thought would be enough for our case.

Furthermore, we wanted to make sure that core Kubernetes components have also room to run properly. That means that core Kubernetes components like the kubelet, apiserver, kube-proxy, node problem detector, etc will have the resources they need in order to operate normally. Again, we can set a kubelet flag like:

```vim {linenos=false}
--kube-reserved-cgroup=kube-reserved --kube-reserved=cpu=500m,memory=3000Mi
```

which set half CPU and 3G of memory aside for our Kubernetes critical components.

Finally, we visited the hard eviction policy which is another kubelet feature that is used to start evicting pods after our system resources get below specific thresholds. We found that the default settings:

```vim {linenos=false}
--eviction-hard=memory.available<100Mi,nodefs.available<10%,nodefs.inodesFree<5%,imagefs.available<10%,imagefs.inodesFree<5%
```

were good enough for us, and we opted to leave these unchanged. For more information on what these values mean we advise to go through the [Kubernetes documentation](https://kubernetes.io/docs/tasks/administer-cluster/out-of-resource/#eviction-signals).

### **Priorities classes**

Besides the reservation of compute resources, we wanted to **make sure that services that we consider important for the whole cluster would get priority in scheduling and have guaranteed resources in the cluster**. This is where priority classes come in. Quoting again from Kubernetes [documentation](https://kubernetes.io/docs/concepts/configuration/pod-priority-preemption/) pages:

> _Priority indicates the importance of a Pod relative to other Pods. If a Pod cannot be scheduled, the scheduler tries to preempt (evict) lower priority Pods to make scheduling of the pending Pod possible._

By default, Kubernetes ships with two priority classes:

1.  **_"system-node-critical"_**, which is the highest existing priority and is meant to be used for system critical pods that must not be moved from their current node, and
2.  **_"system-cluster-critical"_**, that has a bit lower priority and is used for system critical pods that must run in the cluster, but can be moved to another node if necessary.

An example of pods with “_system-node-critical”_ priority is kube-proxy. CoreDNS, kube-apiserver, kube-controller-manager, etcd-manager, kube-scheduler are examples of pods that are usually set with “_system-cluster-critical”_.

After some research we decided to create **three additional priority classes** that would fulfill our needs:

1.  **_"cluster-monitoring-critical"_**, which would be used by pods that are critical for monitoring the whole cluster, e.g. node-exporter, node-problem-detector, spot-termination-exporter.
2.  **_"application-cluster-critical"_**, which would be used by cluster components that will affect several applications like ingress controllers, cluster-autoscaler service, kube2iam, external-dns.
3.  **_"application-monitoring-critical"_**, which would be used by cluster components that will affect monitoring and logging of applications, e.g. grafana, fluentd, prometheus, alertmanager.

**_Something that was not obvious from the official Kubernetes documentation about priority classes, was the fact that for versions less than 1.16 it is required to manually enable priority admission controllers. If not enabled, the priority is not translated into a proper integer and there is no priority scheduling taking place._** \
_More information on how to use Admission Controllers on Kubernetes can be found_ [_here_](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)_._

### **Tools and Services**

#### **Introducing Node Problem Detector**

[Node problem detector](https://github.com/kubernetes/node-problem-detector) is a “Daemonset” that is monitoring logs in the Kubernetes nodes for various problems. Some of the problems include system daemons are down, bad CPU or memory, corrupted file system and kernel issues. As soon as such a problem is detected in the node’s logs, node-problem-detector pods make them visible to the upstream layers, either by sending an API event and updates the NodeCondition or/and by exposing it using prometheus metrics. Based on these we can set alerts and react to problems our nodes are experiencing before they become too serious and start affecting the whole cluster.

#### **Revisiting Cluster Autoscaler**

One tool that we already had and it turned out to be very handy was the [cluster autoscaler](https://github.com/kubernetes/autoscaler). For AWS infrastructure, it runs as a “Deployment” and it’s responsible for scaling out Kubernetes nodes. If the cluster doesn’t have any more resources to schedule new pods for some time, then new nodes will be added to the AWS autoscaling group in order to help serve the additional load. At the same time if there are underutilized nodes in the cluster they will be terminated after being drained to help save some money.

Since the service has a lot of options and is highly configurable we found the opportunity to make some tweaks compared to the initial setup, and also updated the tool to the latest version. Furthermore, we used the prometheus metrics the service is exposing about capacity and unscheduled pods and created alerts to notify us when something is not right.

#### **Hardening CoreDNS**

Service discovery is one of the most important components of a Kubernetes cluster. Thus, we needed to make it more robust and prepare for the expected load. There are a lot of stories [around the internet about outages due to DNS](https://k8s.af), so we thought we need to take some precautionary measures.

These measures are summed up in the following points:

*   **Exploring** [**autopath plugin**](https://coredns.io/plugins/autopath/). If you have a Kubernetes cluster sooner or later you will stumble upon the “ndots:5” situation. In short, this is something that Kubernetes is exposing by default on all Kubernetes containers’ /etc/resolv.conf. That means that for each non-fqdn DNS query our application does, the underlying system call will use the search path of the /etc/resolv.conf and can potentially make up to 5 additional dns queries before getting an answer. You can read more about this [in this article](https://pracucci.com/Kubernetes-dns-resolution-ndots-options-and-why-it-may-affect-application-performances.html). Autopath plugin allows coreDNS to skip some of these queries by creating additional CNAME records. Unfortunately, we found that this plugin is not very robust for our scale and it was breaking often. Part of what we see is described in this [issue](https://github.com/coredns/coredns/issues/3765).
*   **Custom DNS configuration.** We knew the deployment for our monolith application is not taking advantage of all the search paths Kubernetes is offering. Since this deployment would create a lot of traffic to our coreDNS pods we decided to override the default configuration and have a [custom configuration](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#pod-dns-config) for these pods that would have a smaller value for ndots, which would result in less DNS queries towards our coreDNS pods.
*   **Autoscaler for coredns with dns-autoscaler deployment.** This allows coredns to be scaled horizontally automatically based on a number of factors. We have chosen a combination of 1) total number of CPUs in the whole cluster, 2) total number of nodes and 3) a minimum number of coreDNS pods that should always be around. Based on that we have a pretty good way to scale our coreDNS fleet up and down based on the cluster’s capacity.
*   **Disabling AAAA queries to upstream**. Since we don’t use (yet) any IPv6 inside our Kubernetes cluster we thought it would be a waste of our resources to propagate IPv6 queries to the upstream resolvers. Disabling AAAA to the upstream was a quick way for us to save some outgoing queries and use those resources for some more useful traffic.

**_Furthermore, we started investigating and preparing to use_** [**_NodeLocal DNSCache_**](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)**_. The latest (1.18) version of Kubernetes is offering a stable DNS caching agent per machine. With this new architecture we can overcome several_** [**_bottlenecks_**](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/#motivation) **_that our current coreDNS architecture had._**

### **Dedicated Instance Groups**

#### **Monitoring instance nodes**

One of the components that is important for any system is the monitoring stack. **Since we are running our monitoring infrastructure inside the same Kubernetes cluster, we wanted to make sure it is protected from any other service misbehaving**. Any service could potentially go rogue, and we needed our monitoring tools to be healthy in order to debug these faulty services. In order to protect our monitoring tools we decided to move them in a separate Kubernetes instance group, that would be used only from our monitoring tools like prometheus, grafana, alertmanager.

#### **Monolith application instance nodes**

In order to have a smoother transition, we decided to go with a dedicated Kubernetes instance group for our monolith application that we wanted to migrate. **This might be considered as an antipattern from some people but we thought it would be a safer approach to protect both the monolith application and also the rest of our services that are already happy under our Kubernetes cluster**. We aimed to eliminate any impact the monolith would have to the specific nodes and also understand the behavior of the migration. Having multiple tenants inside each node would make the debugging of any problems harder and trickier to squash.

### **Tweak the logging pipeline**

One thing we had in our "to do" pipeline but got a higher priority with this migration was storing each pod’s logs in a different ElasticSearch index. The logs from our Kubernetes cluster and the services that run inside it, were previously propagated using fluentd and stored in our ElasticSearch cluster in a single big index. That used to work okay for a while but as we were growing and onboarding more services in Kubernetes it was not as flexible and scalable as we needed.

As part of our preparations for this migration, we decided to configure fluentd to **propagate each log to a separate ES index based on specific Kubernetes labels**, that were injected in the pod’s logs. Unfortunately, our labels are not always consistent in our deployments, something that forced us having a bit more complex way of deciding the index name. If a deployment doesn’t have any label from a group of labels, we fall back to a default main “blackhole” index. Furthermore, we introduced a custom label that people can use to annotate their pods and override the name of the index. Having all these in place allowed us to stop worrying about the number of logs the monolith would add to our system, and focus on different bottlenecks.

### **Capacity Planning Revisit**

Last but not least, we took the chance to revisit our Kubernetes cluster capacity planning and change the instance’s types based on our current and future needs. We had done this again at least a year ago but since our needs are changing rapidly we thought that was an excellent chance to revisit our capacity planning. That turned out to be useful since we saw we were a bit over-provisioned and we can operate at the same level with a better instance type combination. **Besides instance’s types we tweaked our usage of spot instances and came up with a ratio between reserved and spot instances** that would help us save some more money and at the same time have a reliable infrastructure.

### **Wrapping up**

Installing Kubernetes with the default configuration can get you only this far. As the cluster is growing and hosting more critical services it needs additional attention and maintenance. Multiple critical components can fail as the load increases, and as infrastructure team we should be prepared accordingly. **Reliability is one of the main goals of Beat’s infrastructure team**, and we always try to prepare our platform for each workload we are going to throw at it. We took several steps in order to prepare our Kubernetes cluster for the coming workload increase and protect our reliability. From tweaking kubelet, coreDNS and other tools, to introducing priority classes and dedicated nodes, scaling logging pipelines and revisiting our capacity.

* * *

> This post was originally published in Beat Engineering Blog, as part of my engineering work at Beat. Cross-posting here for posterity reasons.
>
> [Preparing before the storm: Migrating our monolith into Kubernetes](https://medium.com/taxibeat/preparing-before-the-storm-migrating-our-monolith-into-kubernetes-581611c10ae6)
