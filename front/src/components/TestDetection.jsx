import * as ort from 'onnxruntime-web';
import {useEffect} from "react";

const modelPath = process.env.PUBLIC_URL + "/best.onnx";

const TestDetection = () => {
    /**
     * "Upload" button onClick handler: uploads selected image file
     * to backend, receives array of detected objects
     * and draws them on top of image
     */
    useEffect( () => {
        const input = document.getElementById("uploadInput");
        input.addEventListener("change",async(event) => {
            const boxes = await detect_objects_on_image(event.target.files[0]);
            draw_image_and_boxes(event.target.files[0],boxes);
        })
    }, []);

    /**
     * Function draws the image from provided file
     * and bounding boxes of detected objects on
     * top of the image
     * @param file Uploaded file object
     * @param boxes Array of bounding boxes in format [[x1,y1,x2,y2,object_type,probability],...]
     */
    function draw_image_and_boxes(file, boxes) {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.querySelector("canvas");
            const aspectRatio = img.width / img.height;
            const maxWidth = 400;
            const maxHeight = 400;
            let newWidth = img.width;
            let newHeight = img.height;

            // Adjust image dimensions while maintaining aspect ratio
            if (newWidth > maxWidth) {
                newWidth = maxWidth;
                newHeight = newWidth / aspectRatio;
            }
            if (newHeight > maxHeight) {
                newHeight = maxHeight;
                newWidth = newHeight * aspectRatio;
            }

            // Set canvas dimensions
            canvas.width = newWidth;
            canvas.height = newHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, newWidth, newHeight);
            ctx.strokeStyle = "#00FF00";
            ctx.lineWidth = 3;
            ctx.font = "18px serif";

            // Draw bounding boxes
            boxes.forEach(([x1, y1, x2, y2, label]) => {
                const xMultiplier = newWidth / img.width;
                const yMultiplier = newHeight / img.height;
                const adjustedX1 = x1 * xMultiplier;
                const adjustedX2 = x2 * xMultiplier;
                const adjustedY1 = y1 * yMultiplier;
                const adjustedY2 = y2 * yMultiplier;

                ctx.strokeRect(adjustedX1, adjustedY1, adjustedX2 - adjustedX1, adjustedY2 - adjustedY1);
                ctx.fillStyle = "#00ff00";
            });
        };
    }


    /**
     * Function receives an image, passes it through YOLOv8 neural network
     * and returns an array of detected objects and their bounding boxes
     * @param buf Input image body
     * @returns Array of bounding boxes in format [[x1,y1,x2,y2,object_type,probability],..]
     */
    async function detect_objects_on_image(buf) {
        const [input,img_width,img_height] = await prepare_input(buf);
        const output = await run_model(input);
        return process_output(output,img_width,img_height);
    }

    /**
     * Function used to convert input image to tensor,
     * required as an input to YOLOv8 object detection
     * network.
     * @param buf Content of uploaded file
     * @returns Array of pixels
     */
    async function prepare_input(buf) {
        return new Promise(resolve => {
            const img = new Image();
            img.src = URL.createObjectURL(buf);
            img.onload = () => {
                const [img_width,img_height] = [img.width, img.height]
                const canvas = document.createElement("canvas");
                canvas.width = 640;
                canvas.height = 640;
                const context = canvas.getContext("2d");
                context.drawImage(img,0,0,640,640);
                const imgData = context.getImageData(0,0,640,640);
                const pixels = imgData.data;

                const red = [], green = [], blue = [];
                for (let index=0; index<pixels.length; index+=4) {
                    red.push(pixels[index]/255.0);
                    green.push(pixels[index+1]/255.0);
                    blue.push(pixels[index+2]/255.0);
                }
                const input = [...red, ...green, ...blue];
                resolve([input, img_width, img_height])
            }
        })
    }

    /**
     * Function used to pass provided input tensor to YOLOv8 neural network and return result
     * @param input Input pixels array
     * @returns Raw output of neural network as a flat array of numbers
     */
    async function run_model(input) {
        const model = await ort.InferenceSession.create(modelPath);
        input = new ort.Tensor(Float32Array.from(input),[1, 3, 640, 640]);
        const outputs = await model.run({images:input});
        return outputs["output0"].data;
    }

    /**
     * Function used to convert RAW output from YOLOv8 to an array of detected objects.
     * Each object contain the bounding box of this object, the type of object and the probability
     * @param output Raw output of YOLOv8 network
     * @param img_width Width of original image
     * @param img_height Height of original image
     * @returns Array of detected objects in a format [[x1,y1,x2,y2,object_type,probability],..]
     */
    function process_output(output, img_width, img_height) {
        let boxes = [];
        for (let index=0;index<8400;index++) {
            const [class_id,prob] = [...Array(80).keys()]
                .map(col => [col, output[8400*(col+4)+index]])
                .reduce((accum, item) => item[1]>accum[1] ? item : accum,[0,0]);
            if (prob < 0.8) {
                continue;
            }
            const label = yolo_classes[class_id];
            const xc = output[index];
            const yc = output[8400+index];
            const w = output[2*8400+index];
            const h = output[3*8400+index];
            const x1 = (xc-w/2)/640*img_width;
            const y1 = (yc-h/2)/640*img_height;
            const x2 = (xc+w/2)/640*img_width;
            const y2 = (yc+h/2)/640*img_height;
            boxes.push([x1,y1,x2,y2,label,prob]);
        }

        boxes = boxes.sort((box1,box2) => box2[5]-box1[5])
        const result = [];
        while (boxes.length>0) {
            result.push(boxes[0]);
            boxes = boxes.filter(box => iou(boxes[0],box)<0.7);
        }
        return result;
    }

    /**
     * Function calculates "Intersection-over-union" coefficient for specified two boxes
     * https://pyimagesearch.com/2016/11/07/intersection-over-union-iou-for-object-detection/.
     * @param box1 First box in format: [x1,y1,x2,y2,object_class,probability]
     * @param box2 Second box in format: [x1,y1,x2,y2,object_class,probability]
     * @returns Intersection over union ratio as a float number
     */
    function iou(box1,box2) {
        return intersection(box1,box2)/union(box1,box2);
    }

    /**
     * Function calculates union area of two boxes.
     *     :param box1: First box in format [x1,y1,x2,y2,object_class,probability]
     *     :param box2: Second box in format [x1,y1,x2,y2,object_class,probability]
     *     :return: Area of the boxes union as a float number
     * @param box1 First box in format [x1,y1,x2,y2,object_class,probability]
     * @param box2 Second box in format [x1,y1,x2,y2,object_class,probability]
     * @returns Area of the boxes union as a float number
     */
    function union(box1,box2) {
        const [box1_x1,box1_y1,box1_x2,box1_y2] = box1;
        const [box2_x1,box2_y1,box2_x2,box2_y2] = box2;
        const box1_area = (box1_x2-box1_x1)*(box1_y2-box1_y1)
        const box2_area = (box2_x2-box2_x1)*(box2_y2-box2_y1)
        return box1_area + box2_area - intersection(box1,box2)
    }

    /**
     * Function calculates intersection area of two boxes
     * @param box1 First box in format [x1,y1,x2,y2,object_class,probability]
     * @param box2 Second box in format [x1,y1,x2,y2,object_class,probability]
     * @returns Area of intersection of the boxes as a float number
     */
    function intersection(box1,box2) {
        const [box1_x1,box1_y1,box1_x2,box1_y2] = box1;
        const [box2_x1,box2_y1,box2_x2,box2_y2] = box2;
        const x1 = Math.max(box1_x1,box2_x1);
        const y1 = Math.max(box1_y1,box2_y1);
        const x2 = Math.min(box1_x2,box2_x2);
        const y2 = Math.min(box1_y2,box2_y2);
        return (x2-x1)*(y2-y1)
    }

    /**
     * Array of YOLOv8 class labels
     */
    const yolo_classes = ['poke_card'];

    return(
        <div>
            <h1>TESTE</h1>
            <input id="uploadInput" type="file"/>
            <canvas></canvas>
        </div>
    );
}

export default TestDetection;