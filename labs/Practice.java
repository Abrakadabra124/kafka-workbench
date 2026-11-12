import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.config.ConfigResource;
import org.apache.kafka.common.serialization.*;

/** Only the three dedicated practice topics are accepted by this adapter. */
class Practice {
  static final Set<String> TOPICS=Set.of("wb-poison-quarantine","wb-isr-write-gate","wb-retention-gap");
  static List<TopicPartition> partitions(String topic) {
    return List.of(new TopicPartition(topic,0),new TopicPartition(topic,1),new TopicPartition(topic,2));
  }
  static Properties producerProperties(boolean probe) {
    var p=Workbench.base();
    p.put("key.serializer",StringSerializer.class.getName()); p.put("value.serializer",StringSerializer.class.getName());
    p.put("acks","all"); p.put("enable.idempotence",String.valueOf(!probe));
    p.put("delivery.timeout.ms","15000"); p.put("max.block.ms","8000");
    if(probe) { p.put("retries","0"); p.put("request.timeout.ms","2000"); p.put("delivery.timeout.ms","5000"); }
    return p;
  }
  static Map<String,Object> send(KafkaProducer<String,String> p,String topic,String key,String value) throws Exception {
    var r=p.send(new ProducerRecord<String,String>(topic,0,key,value)).get(18,TimeUnit.SECONDS);
    return Map.of("partition",r.partition(),"offset",r.offset(),"key",key,"value",value);
  }
  static List<Map<String,Object>> read(String topic) {
    var rows=new ArrayList<Map<String,Object>>();
    try(var c=Workbench.consumer(topic+"-independent",36)) {
      var parts=partitions(topic); c.assign(parts);
      var beginnings=c.beginningOffsets(parts); var ends=c.endOffsets(parts);
      long count=parts.stream().mapToLong(p->ends.get(p)-beginnings.get(p)).sum();
      if(count>36) throw new IllegalStateException("Practice topic exceeds bounded evidence limit");
      for(var p:parts) c.seek(p,beginnings.get(p));
      long deadline=System.currentTimeMillis()+12000;
      while(rows.size()<count && System.currentTimeMillis()<deadline)
        for(var r:c.poll(Duration.ofMillis(300))) rows.add(Workbench.record(r));
      if(rows.size()!=count) throw new IllegalStateException("Independent read did not reach measured log end");
    }
    return rows;
  }
  static void configure(Admin admin,String topic,String value) throws Exception {
    var resource=new ConfigResource(ConfigResource.Type.TOPIC,topic);
    admin.incrementalAlterConfigs(Map.of(resource,List.of(new AlterConfigOp(new ConfigEntry("min.insync.replicas",value),AlterConfigOp.OpType.SET)))).all().get();
  }
  static int minIsr(Admin admin,String topic) throws Exception {
    var resource=new ConfigResource(ConfigResource.Type.TOPIC,topic);
    return Integer.parseInt(admin.describeConfigs(List.of(resource)).all().get().get(resource).get("min.insync.replicas").value());
  }
  static void commitEnd(Admin admin,String topic,String group) throws Exception {
    var ends=new HashMap<TopicPartition,OffsetSpec>(); for(var p:partitions(topic)) ends.put(p,OffsetSpec.latest());
    var offsets=new HashMap<TopicPartition,OffsetAndMetadata>();
    for(var e:admin.listOffsets(ends).all().get().entrySet()) offsets.put(e.getKey(),new OffsetAndMetadata(e.getValue().offset()));
    admin.alterConsumerGroupOffsets(group,offsets).all().get();
  }
  static List<Map<String,Object>> inputRecords() {
    var rows=new ArrayList<Map<String,Object>>();
    try(var scanner=new Scanner(System.in,StandardCharsets.UTF_8)) {
      while(scanner.hasNextLine()) {
        var parts=scanner.nextLine().split("\t",-1);
        if(parts.length!=3 || rows.size()>=36) throw new IllegalArgumentException("Invalid archive envelope");
        rows.add(Map.of("key",new String(Base64.getDecoder().decode(parts[1]),StandardCharsets.UTF_8),"value",new String(Base64.getDecoder().decode(parts[2]),StandardCharsets.UTF_8)));
      }
    }
    return rows;
  }
  static void uniqueSend(KafkaProducer<String,String> producer,String topic,String key,String value,Map<String,String> existing) throws Exception {
    if(existing.containsKey(key)) {
      if(!Objects.equals(existing.get(key),value)) throw new IllegalStateException("Conflicting replay payload");
      return;
    }
    send(producer,topic,key,value); existing.put(key,value);
  }
  static Map<String,String> existing(String topic) {
    var result=new HashMap<String,String>();
    for(var row:read(topic)) {
      String old=result.put((String)row.get("key"),(String)row.get("value"));
      if(old!=null) throw new IllegalStateException("Duplicate effect in target topic");
    }
    return result;
  }
  static Object execute(Admin admin,String action,String topic,String group) throws Exception {
    // One-shot process deadline also stops the client inside the container if the Docker CLI disconnects.
    Thread watchdog=new Thread(() -> { try { Thread.sleep(55000); System.err.println("Practice deadline exceeded"); Runtime.getRuntime().halt(124); } catch(InterruptedException ignored) {} });
    watchdog.setDaemon(true); watchdog.start();
    if(!TOPICS.contains(topic) || !group.equals(topic+"-orders")) throw new IllegalArgumentException("Unsupported practice scope");
    boolean poison=topic.equals("wb-poison-quarantine"), isr=topic.equals("wb-isr-write-gate");
    var managed=new ArrayList<String>(); managed.add(topic);
    if(poison) { managed.add(topic+"-quarantine"); managed.add(topic+"-processed"); }
    if(!poison && !isr) managed.add(topic+"-recovered");
    if(action.equals("practice-prepare")) {
      var exists=admin.listTopics().names().get(); var remove=managed.stream().filter(exists::contains).toList();
      if(!remove.isEmpty()) admin.deleteTopics(remove).all().get();
      try { admin.deleteConsumerGroups(List.of(group)).all().get(); }
      catch(ExecutionException e) { if(!(e.getCause() instanceof org.apache.kafka.common.errors.GroupIdNotFoundException)) throw e; }
      long deadline=System.currentTimeMillis()+15000;
      while(admin.listTopics().names().get().stream().anyMatch(managed::contains)) {
        if(System.currentTimeMillis()>deadline) throw new IllegalStateException("Practice topic cleanup not complete"); Thread.sleep(200);
      }
      for(String name:managed) admin.createTopics(List.of(new NewTopic(name,Map.of(0,List.of(1,2,3),1,List.of(2,3,1),2,List.of(3,1,2))).configs(Map.of("min.insync.replicas",isr?"3":"2")))).all().get();
      var records=new ArrayList<Object>();
      try(var p=new KafkaProducer<String,String>(producerProperties(false))) {
        for(int i=0;i<3;i++) records.add(send(p,topic,"E"+i,poison && i==1 ? "{broken" : "{\"eventId\":\"E"+i+"\",\"amount\":100}"));
      }
      var offsets=new HashMap<TopicPartition,OffsetAndMetadata>(); for(var p:partitions(topic)) offsets.put(p,new OffsetAndMetadata(0));
      admin.alterConsumerGroupOffsets(group,offsets).all().get();
      return Map.of("records",records,"prepared",true);
    }
    if(action.equals("practice-inspect")) {
      var evidence=new LinkedHashMap<String,Object>(); evidence.put("source",read(topic)); evidence.put("minIsr",minIsr(admin,topic));
      evidence.put("start",admin.listOffsets(Map.of(new TopicPartition(topic,0),OffsetSpec.earliest())).all().get().values().iterator().next().offset());
      if(poison) { evidence.put("quarantine",read(topic+"-quarantine")); evidence.put("processed",read(topic+"-processed")); }
      if(!poison && !isr) evidence.put("recovered",read(topic+"-recovered"));
      return evidence;
    }
    if(action.equals("practice-wrong")) {
      if(isr) configure(admin,topic,"2"); else commitEnd(admin,topic,group);
      return Map.of("shortcutApplied",true);
    }
    if(action.equals("practice-retry")) {
      if(poison || isr) return execute(admin,"practice-fault",topic,group);
      var known=existing(topic+"-recovered");
      try(var p=new KafkaProducer<String,String>(producerProperties(false))) {
        for(var row:read(topic)) uniqueSend(p,topic+"-recovered",(String)row.get("key"),(String)row.get("value"),known);
      }
      return Map.of("message","Only available tail replayed; removed record is still missing");
    }
    if(action.equals("practice-fault")) {
      if(poison) {
        var tp=new TopicPartition(topic,0);
        var known=existing(topic+"-processed");
        try(var c=Workbench.consumer(group,3); var p=new KafkaProducer<String,String>(producerProperties(false))) {
          c.assign(List.of(tp));
          var committed=c.committed(Set.of(tp)).get(tp); c.seek(tp,committed==null ? 0 : committed.offset());
          long deadline=System.currentTimeMillis()+10000;
          while(System.currentTimeMillis()<deadline) {
            for(var r:c.poll(Duration.ofMillis(300))) {
              if(!r.value().matches("\\{\"eventId\":\"E[0-9]+\",\"amount\":[0-9]+\\}"))
                return Map.of("code","SchemaViolation","partition",r.partition(),"offset",r.offset(),"payload",r.value(),"message","Обработчик остановлен на нарушении контракта; offset проблемной записи не подтверждён.");
              uniqueSend(p,topic+"-processed",r.key(),r.value(),known);
              c.commitSync(Map.of(tp,new OffsetAndMetadata(r.offset()+1)));
            }
          }
        }
        return Map.of("message","Нарушение контракта не найдено");
      }
      if(isr) {
        try(var p=new KafkaProducer<String,String>(producerProperties(true))) {
          try { send(p,topic,"rejected-probe","requires-three-replicas"); return Map.of("message","Запись принята: ожидаемая ошибка не воспроизведена"); }
          catch(ExecutionException e) { return Map.of("code",e.getCause().getClass().getSimpleName(),"message",String.valueOf(e.getCause().getMessage())); }
        }
      }
      // This operation can only remove the initial record of the dedicated task topic.
      admin.deleteRecords(Map.of(new TopicPartition(topic,0),RecordsToDelete.beforeOffset(1))).all().get();
      var properties=Workbench.base(); properties.put("group.id",group); properties.put("enable.auto.commit","false"); properties.put("auto.offset.reset","none");
      properties.put("key.deserializer",StringDeserializer.class.getName()); properties.put("value.deserializer",StringDeserializer.class.getName());
      try(var c=new KafkaConsumer<String,String>(properties)) {
        var p=new TopicPartition(topic,0); c.assign(List.of(p)); c.seek(p,0);
        try { long deadline=System.currentTimeMillis()+8000; while(System.currentTimeMillis()<deadline) c.poll(Duration.ofMillis(500)); return Map.of("message","Ошибка позиции пока не наблюдалась"); }
        catch(org.apache.kafka.clients.consumer.OffsetOutOfRangeException e) { return Map.of("code",e.getClass().getSimpleName(),"message","Позиция 0 ниже реального log start после ограниченной инъекции удаления."); }
      }
    }
    if(action.equals("practice-repair") || (poison && action.equals("practice-interrupt"))) {
      if(isr) {
        configure(admin,topic,"3");
        try(var p=new KafkaProducer<String,String>(producerProperties(false))) {
          var previous=read(topic).stream().filter(r -> "recovery-proof".equals(r.get("key"))).toList();
          if(previous.size()>1) throw new IllegalStateException("Duplicate recovery proof");
          var proof=previous.isEmpty() ? send(p,topic,"recovery-proof","acks=all;minISR=3") : previous.get(0);
          return Map.of("repaired",true,"proof",proof);
        }
      } else if(poison) {
        var quarantine=existing(topic+"-quarantine"); var processed=existing(topic+"-processed");
        try(var p=new KafkaProducer<String,String>(producerProperties(false))) {
          for(var row:read(topic)) {
            String value=(String)row.get("value");
            if(!value.matches("\\{\"eventId\":\"E[0-9]+\",\"amount\":[0-9]+\\}")) {
              String key=topic+":"+row.get("partition")+":"+row.get("offset");
              var envelope=new LinkedHashMap<String,Object>(); envelope.put("sourceTopic",topic); envelope.put("partition",row.get("partition")); envelope.put("offset",row.get("offset")); envelope.put("payload",value); envelope.put("reason","SCHEMA_VIOLATION");
              uniqueSend(p,topic+"-quarantine",key,Workbench.json(envelope),quarantine);
              if(action.equals("practice-interrupt")) return Map.of("interruptedBeforeCommit",true);
            } else uniqueSend(p,topic+"-processed",(String)row.get("key"),value,processed);
          }
        }
        commitEnd(admin,topic,group);
      } else {
        var archive=inputRecords(); if(archive.size()!=3) throw new IllegalArgumentException("Original archive is required");
        var known=existing(topic+"-recovered");
        try(var p=new KafkaProducer<String,String>(producerProperties(false))) {
          for(var row:archive) uniqueSend(p,topic+"-recovered",(String)row.get("key"),(String)row.get("value"),known);
        }
      }
      return Map.of("repaired",true);
    }
    throw new IllegalArgumentException("Unsupported practice operation");
  }
}
