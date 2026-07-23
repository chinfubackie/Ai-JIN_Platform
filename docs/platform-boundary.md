# ขอบเขต Ai-JIN Platform และ App AI Camera

## หลักการ

ระบบทั้งสองส่วนต้องทำงานจากคนละ workspace และไม่ใช้ runtime directory ร่วมกัน

| ระบบ | Workspace หลัก | หน้าที่ |
|---|---|---|
| Ai-JIN Platform | **D:\Ai-JIN_Platform** | Web UI, API, Label Studio, dataset preparation, training, model registry และ inference |
| App AI Camera | **D:\Ai-JIN_V10.0_patch_output** | PyQt5 operator app, camera/PLC runtime, tracking, counting และ runtime state หน้างาน |

## Runtime ที่ Platform เป็นเจ้าของ

- Dataset: **D:\Ai-JIN_Platform\dataset**
- Training runs: **D:\Ai-JIN_Platform\runs**
- Models: **D:\Ai-JIN_Platform\models**
- Web API: **D:\Ai-JIN_Platform\webapp**
- Docker stack: **D:\Ai-JIN_Platform\docker-compose.yml**

ไฟล์ **D:\Ai-JIN_Platform\.env** เป็นค่าหลักบน Windows:

~~~dotenv
DATASET_PATH=D:/Ai-JIN_Platform/dataset
RUNS_PATH=D:/Ai-JIN_Platform/runs
MODEL_PATH=D:/Ai-JIN_Platform/models
~~~

เมื่อไม่มี .env หรือ env vars, webapp/app.py จะใช้ path ภายใต้ Platform workspace เท่านั้น และห้าม fallback ไป App AI Camera

## Runtime ที่ App AI Camera เป็นเจ้าของ

- Source และ GUI: **D:\Ai-JIN_V10.0_patch_output\app**
- Camera dataset/runtime capture: **D:\Ai-JIN_V10.0_patch_output\dataset**
- Camera training/inference runs: **D:\Ai-JIN_V10.0_patch_output\runs**
- Logs/state/config: อยู่ใต้ **D:\Ai-JIN_V10.0_patch_output** ตาม AGENTS.md

Platform จะไม่อ่านหรือเขียน path เหล่านี้โดย implicit fallback หากต้องแลกเปลี่ยนข้อมูล ให้ใช้ export/import ที่ระบุ path หรือ API อย่างชัดเจน

## Legacy Platform stack จาก V10

Platform stack รุ่นเก่าเคยอยู่ใต้ **D:\Ai-JIN_V10.0_patch_output\docker** และถูกแยกออกจาก App AI Camera โดยเก็บแบบ read-only reference ที่:

**D:\Ai-JIN_Platform\legacy\v10-platform-stack-20260722**

โค้ดที่ใช้งานจริงยังคงเป็น **D:\Ai-JIN_Platform\webapp** และ **D:\Ai-JIN_Platform\docker-compose.yml** ห้ามเปิดบริการจาก legacy archive

## การตรวจสอบ boundary

~~~powershell
cd D:\Ai-JIN_Platform
py -3.12 -m pytest webapp/tests/test_platform_boundary.py -v
rg "Ai-JIN_V10.0_patch_output" webapp docker-compose.yml
~~~

คำสั่ง rg ต้องไม่พบ reference ใน source/runtime config ของ Platform
